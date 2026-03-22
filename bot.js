import "dotenv/config"
import TelegramBot from "node-telegram-bot-api"

import {TELEGRAM_TOKEN, MODEL, ADMIN_ID, TEACHER_IDS, TRANSLATE_ENGINE} from "./config.js"
import {
    addText, getAll, clearQueue,
    getCachedWords, addCachedWords, clearAnkiCache,
    getLLMCache, setLLMCache,
    getUserSetting, setUserSetting,
    addTokenUsage, getTokenUsage,
    addGoogleTranslateWords,
    getUserTokenUsage, getGoogleTranslateWords, getAllUsersWithStats
} from "./db.js"
import {Readable} from "stream"
import {generateCards} from "./openai.js"
import {translateWords} from "./translate.js"
import {generateCSV, generateText} from "./csv.js"
import {anki} from "./anki.js"
import {downloadAudio} from "./tts.js"

const bot = new TelegramBot(
    TELEGRAM_TOKEN,
    {polling: true}
)

const AUTO_DELETE_MS = 3000
async function sendTempMessage(chatId, text, options = {}) {
    const msg = await bot.sendMessage(chatId, text, options)
    setTimeout(() => {
        bot.deleteMessage(chatId, msg.message_id)
            .catch(() => {})
    }, AUTO_DELETE_MS)
    return msg
}

ensureAnkiCache().catch(console.error)

bot.setMyCommands([
    {command: "start", description: "Start bot"},
    {command: "clear", description: "Clear queue"},
    {command: "lang", description: "Set language, e.g. /lang Turkish"},
    {command: "resync", description: "Rebuild Anki cache"},
    {command: "stats", description: "Show token usage and cost"},
]).catch(console.error)

// Per-user in-memory state
const queueMessageIds = new Map()  // userId → messageId
const importInProgress = new Set() // userId
const pendingCards = new Map()     // userId → cards[]

// Restore admin's queue message ID from DB on startup
getUserSetting(ADMIN_ID, "queue_message_id").then(val => {
    if (val && val !== "0") queueMessageIds.set(ADMIN_ID, Number(val))
}).catch(console.error)

function setQueueMessageId(userId, id) {
    if (id) {
        queueMessageIds.set(userId, id)
    } else {
        queueMessageIds.delete(userId)
    }
    setUserSetting(userId, "queue_message_id", id ? String(id) : "0").catch(console.error)
}

function normalize(word) {
    return word
        .toLowerCase()
        .replace(/[–—-]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
}

function splitInput(text) {
    return text
        .split(/[,;\n]/)
        .map(s => s.trim())
        .filter(Boolean)
}

async function mapLimit(arr, limit, fn) {
    const ret = []
    const executing = []
    for (const item of arr) {
        const p = Promise.resolve().then(() => fn(item))
        ret.push(p)
        if (limit <= arr.length) {
            const e = p.finally(() => {
                const idx = executing.indexOf(e)
                if (idx >= 0) executing.splice(idx, 1)
            })
            executing.push(e)
            if (executing.length >= limit) {
                await Promise.race(executing)
            }
        }
    }
    return Promise.all(ret)
}

async function ensureAnkiCache() {
    try {
        const cached = await getCachedWords()
        if (cached.size > 0) return
        console.log("Anki cache empty → running resync")
        const result = await anki("multi", {
            actions: [
                {
                    action: "findNotes",
                    params: {query: "Word:*"}
                }
            ]
        })
        const ids = result[0]
        if (!ids.length) return
        const notes = await anki("notesInfo", {
            notes: ids
        })
        const words = notes.map(n => normalize(n.fields.Word.value))
        await addCachedWords(words)
        console.log(`Cached ${words.length} words`)
    } catch (err) {
        console.log("Anki cache init failed")
        console.error(err)
    }
}

async function updateQueueMessage(chatId, userId) {
    const isAdmin = userId === ADMIN_ID

    // Restore queue message ID from DB if not in memory
    let queueMsgId = queueMessageIds.get(userId)
    if (!queueMsgId) {
        const stored = await getUserSetting(userId, "queue_message_id").catch(() => null)
        if (stored && stored !== "0") {
            queueMsgId = Number(stored)
            queueMessageIds.set(userId, queueMsgId)
        }
    }

    const items = await getAll(userId)
    if (!items.length) {
        const text = "Queue is empty"
        if (queueMsgId) {
            try {
                const ok = await bot.editMessageText(
                    text,
                    {
                        chat_id: chatId,
                        message_id: queueMsgId,
                        reply_markup: {inline_keyboard: []}
                    }
                )
                if (ok) return
            } catch {}
            setQueueMessageId(userId, null)
        }
        const sent = await bot.sendMessage(chatId, text)
        setQueueMessageId(userId, sent.message_id)
        return
    }

    const limit = 5
    const preview = items
        .slice(0, limit)
        .map((w, i) => `${i + 1}. ${w.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}`)
        .join("\n")
    let message = `Queued words: ${items.length}\n\n${preview}`
    if (items.length > limit) {
        message += `\n...and ${items.length - limit} more`
    }

    let allExist = false
    if (isAdmin) {
        try {
            const cached = await getCachedWords()
            allExist = items.every(t => cached.has(normalize(t)))
        } catch {}
        if (allExist) {
            message += `\n\n<b>All words already exist in Anki</b>`
        }
    }

    const buttons = [
        ...(!allExist ? [{text: "Generate flashcards", callback_data: "generate"}] : []),
        {text: "Clear queue", callback_data: "clear"}
    ]
    const markup = {
        parse_mode: "HTML",
        reply_markup: {inline_keyboard: [buttons]}
    }

    if (queueMsgId) {
        try {
            const ok = await bot.editMessageText(message, {chat_id: chatId, message_id: queueMsgId, ...markup})
            if (ok) return
        } catch {}
        setQueueMessageId(userId, null)
    }
    const sent = await bot.sendMessage(chatId, message, markup)
    setQueueMessageId(userId, sent.message_id)
}

function formatCardsPreview(cards) {
    const lines = cards.map(c => {
        let line = `<b>${c.word}</b> — ${c.translation}\n<i>${c.example}</i>`
        if (c.deck) line += `\n${c.deck}  ${c.tags?.join("  ") || ""}`
        return line
    })
    return `Generated ${cards.length} card${cards.length !== 1 ? "s" : ""}:\n\n` + lines.join("\n\n")
}

bot.on("message", async msg => {
    setTimeout(() => {
        bot.deleteMessage(msg.chat.id, msg.message_id)
            .catch(() => {})
    }, AUTO_DELETE_MS)

    const text = msg.text?.trim()
    if (!text) return
    if (text.startsWith("/")) return

    const userId = msg.from.id
    const chatId = msg.chat.id

    // Store display name for stats (fire-and-forget)
    const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ")
    if (name) setUserSetting(userId, "name", name).catch(() => {})

    const isTeacher = TEACHER_IDS.includes(userId)
    const targetUserId = isTeacher ? ADMIN_ID : userId

    const parts = splitInput(text)

    const existing = new Set(
        (await getAll(targetUserId)).map(normalize)
    )

    let added = 0
    for (const p of parts) {
        const n = normalize(p)
        if (existing.has(n)) {
            if (!isTeacher) await sendTempMessage(chatId, `"${p}" already in queue`)
            continue
        }

        await addText(targetUserId, p)
        existing.add(n)
        added++
    }

    if (added) {
        if (isTeacher) {
            await sendTempMessage(chatId, `Added to queue ✓`)
        } else {
            await updateQueueMessage(chatId, userId)
        }
    }
})


bot.onText(/\/start/, async msg => {
    await sendTempMessage(msg.chat.id, "Send words or phrases")
    await updateQueueMessage(msg.chat.id, msg.from.id)
})

bot.onText(/\/resync/, async msg => {
    if (msg.from.id !== ADMIN_ID) {
        await sendTempMessage(msg.chat.id, "Only the deck owner can initiate a resync.")
        return
    }
    try {
        await sendTempMessage(msg.chat.id, "Rebuilding Anki cache...")
        const ids = await anki(
            "findNotes",
            {query: "Word:*"}
        )
        if (!ids.length) {
            await sendTempMessage(msg.chat.id, "No cards found in Anki")
            return
        }
        const notes = await anki(
            "notesInfo",
            {notes: ids}
        )
        const words = notes.map(n => normalize(n.fields.Word.value))
        await clearAnkiCache()
        await addCachedWords(words)
        await sendTempMessage(msg.chat.id, `Cache rebuilt: ${words.length} words`)
    } catch (err) {
        console.log(err)
        await sendTempMessage(msg.chat.id, "Failed to rebuild cache")
    }
})

// gpt-4.1-mini pricing (per 1M tokens)
const PRICE_INPUT  = 0.40
const PRICE_OUTPUT = 1.60

bot.onText(/\/stats/, async msg => {
    if (msg.from.id !== ADMIN_ID) return

    const userIds = await getAllUsersWithStats()

    const lines = []

    for (const uid of userIds) {
        const [name, {promptTokens, completionTokens}, googleWords] = await Promise.all([
            getUserSetting(uid, "name"),
            getUserTokenUsage(uid),
            getGoogleTranslateWords(uid),
        ])
        const label = name ? `${name} (${uid})` : `User ${uid}`
        const marker = uid === ADMIN_ID ? " 👑" : ""
        lines.push(`<b>${label}${marker}</b>`)
        if (promptTokens || completionTokens) {
            const cost = (promptTokens * PRICE_INPUT + completionTokens * PRICE_OUTPUT) / 1_000_000
            lines.push(`  GPT: ${promptTokens.toLocaleString()} in / ${completionTokens.toLocaleString()} out — $${cost.toFixed(4)}`)
        }
        if (googleWords) {
            lines.push(`  Google Translate: ${googleWords.toLocaleString()} words`)
        }
    }

    const {promptTokens: totalIn, completionTokens: totalOut} = await getTokenUsage()
    const totalCost = (totalIn * PRICE_INPUT + totalOut * PRICE_OUTPUT) / 1_000_000

    const header = userIds.length
        ? `📊 <b>Usage by user:</b>\n\n${lines.join("\n")}\n\n`
        : ""
    const footer = `<b>Total GPT:</b> ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out — $${totalCost.toFixed(4)}`

    await bot.sendMessage(msg.chat.id, header + footer, {parse_mode: "HTML"})
})

bot.onText(/\/clear/, async msg => {
    const userId = msg.from.id
    const items = await getAll(userId)
    if (!items.length) return
    await clearQueue(userId)
    setQueueMessageId(userId, null)
    await updateQueueMessage(msg.chat.id, userId)
})

bot.onText(/\/lang/, async msg => {
    const userId = msg.from.id
    const match = msg.text.match(/^\/lang\s+(.+)$/)
    if (!match) {
        const current = await getUserSetting(userId, "lang") || "English"
        await sendTempMessage(msg.chat.id, `Current language: ${current}\nUse /lang <language> to change, e.g. /lang Turkish`)
        return
    }
    const lang = match[1].trim()
    await setUserSetting(userId, "lang", lang)
    await sendTempMessage(msg.chat.id, `Language set to ${lang} ✓`)
})

bot.on("callback_query", async q => {

    const chatId = q.message.chat.id
    const messageId = q.message.message_id
    const userId = q.from.id
    let items

    const userQueueMsgId = queueMessageIds.get(userId)
    if (userQueueMsgId && messageId !== userQueueMsgId) {
        await bot.deleteMessage(chatId, messageId).catch(() => {})
        await bot.answerCallbackQuery(q.id, {text: "This message is outdated"})
        return
    }

    try {
        switch (q.data) {

            case "generate":
                if (importInProgress.has(userId)) {
                    await bot.answerCallbackQuery(q.id, {text: "Import already running"})
                    return
                }
                items = await getAll(userId)
                if (!items.length) {
                    await bot.answerCallbackQuery(q.id, {text: "Queue is empty"})
                    return
                }
                importInProgress.add(userId)
                await bot.editMessageText(
                    "Generating flashcards...",
                    {chat_id: chatId, message_id: messageId}
                )
                try {
                    let cards
                    const isAdmin = userId === ADMIN_ID

                    if (isAdmin) {
                        const existing = await getCachedWords()
                        const missing = items.filter(t => !existing.has(normalize(t)))
                        if (!missing.length) {
                            await clearQueue(userId)
                            setQueueMessageId(userId, null)
                            pendingCards.delete(userId)
                            await bot.editMessageText(
                                "All words already exist in Anki",
                                {chat_id: chatId, message_id: messageId, reply_markup: {inline_keyboard: []}}
                            )
                            await bot.answerCallbackQuery(q.id)
                            break
                        }
                        const raw = missing.join("\n")
                        const language = "English"
                        cards = await getLLMCache(raw, language)
                        if (!cards) {
                            const result = await generateCards(raw, language)
                            cards = result.cards
                            await setLLMCache(raw, language, cards)
                            await addTokenUsage(result.usage.prompt_tokens, result.usage.completion_tokens, userId).catch(console.error)
                        }
                    } else {
                        const language = await getUserSetting(userId, "lang") || "English"
                        const raw = items.join("\n")
                        const useGPT = TRANSLATE_ENGINE !== "google"

                        if (useGPT) {
                            cards = await getLLMCache(raw, language)
                            if (!cards) {
                                const result = await generateCards(raw, language)
                                cards = result.cards
                                await setLLMCache(raw, language, cards)
                                await addTokenUsage(result.usage.prompt_tokens, result.usage.completion_tokens, userId).catch(console.error)
                            }
                        } else {
                            const cacheKey = `google:${language}`
                            cards = await getLLMCache(raw, cacheKey)
                            if (!cards) {
                                cards = await translateWords(items, language)
                                await setLLMCache(raw, cacheKey, cards)
                                await addGoogleTranslateWords(userId, items.length).catch(console.error)
                            }
                        }
                    }

                    if (!cards.length) {
                        pendingCards.delete(userId)
                        await bot.editMessageText(
                            "No vocabulary detected",
                            {chat_id: chatId, message_id: messageId, reply_markup: {inline_keyboard: []}}
                        )
                        await bot.answerCallbackQuery(q.id)
                        break
                    }

                    pendingCards.set(userId, cards)
                    const isAdminUser = userId === ADMIN_ID
                    const actionButtons = isAdminUser
                        ? [{text: "Send to Anki", callback_data: "send_to_anki"}]
                        : [
                            {text: "Get CSV", callback_data: "get_csv"},
                            {text: "Get text", callback_data: "get_text"}
                          ]
                    await bot.editMessageText(
                        formatCardsPreview(cards),
                        {
                            chat_id: chatId,
                            message_id: messageId,
                            parse_mode: "HTML",
                            reply_markup: {
                                inline_keyboard: [[
                                    ...actionButtons,
                                    {text: "Cancel", callback_data: "cancel_preview"}
                                ]]
                            }
                        }
                    )
                    await bot.answerCallbackQuery(q.id)
                } catch (err) {
                    pendingCards.delete(userId)
                    if (err.code === "insufficient_quota") {
                        await sendTempMessage(chatId, "OpenAI API quota exceeded. Check billing.")
                    } else if (err.message === "INVALID_JSON_FROM_LLM") {
                        await sendTempMessage(chatId, "Failed to parse AI response. Please try again.")
                    } else if (err.message?.startsWith("INVALID_DECK_FROM_LLM")) {
                        await sendTempMessage(chatId, "AI returned an unknown deck. Please try again.")
                    } else {
                        console.log(err)
                    }
                    await updateQueueMessage(chatId, userId)
                    await bot.answerCallbackQuery(q.id, {text: "Error occurred"})
                } finally {
                    importInProgress.delete(userId)
                }
                break

            case "send_to_anki":
                if (userId !== ADMIN_ID) {
                    await bot.answerCallbackQuery(q.id, {text: "Only the deck owner can import cards."})
                    return
                }
                if (importInProgress.has(userId)) {
                    await bot.answerCallbackQuery(q.id, {text: "Import already running"})
                    return
                }
                if (!pendingCards.get(userId)) {
                    await bot.answerCallbackQuery(q.id, {text: "Session expired — regenerate cards first"})
                    await updateQueueMessage(chatId, userId)
                    return
                }
                importInProgress.add(userId)
                await bot.editMessageText(
                    "Importing...",
                    {chat_id: chatId, message_id: messageId, reply_markup: {inline_keyboard: []}}
                )
                try {
                    const cards = pendingCards.get(userId)
                    const audio = await mapLimit(cards, 5, c => downloadAudio(c.word))
                    const notes = cards.map((c, i) => ({
                        deckName: c.deck,
                        modelName: MODEL,
                        fields: {
                            Word: c.word,
                            Translation: c.translation,
                            Example: c.example,
                            Pronunciation: audio[i]
                        },
                        tags: c.tags
                    }))
                    await anki("addNotes", {notes})
                    await addCachedWords(cards.map(c => normalize(c.word)))
                    await clearQueue(userId)
                    pendingCards.delete(userId)
                    setQueueMessageId(userId, null)
                    await bot.editMessageText(
                        `Imported ${notes.length} card${notes.length !== 1 ? "s" : ""}:\n\n${cards.map(c => c.word).join("\n")}`,
                        {chat_id: chatId, message_id: messageId}
                    )
                    await bot.answerCallbackQuery(q.id)
                } catch (err) {
                    if (err.code === "ECONNREFUSED") {
                        await sendTempMessage(chatId, "Anki is not running. Start Anki and try again.")
                        const cards = pendingCards.get(userId)
                        if (cards) {
                            await bot.editMessageText(
                                formatCardsPreview(cards),
                                {
                                    chat_id: chatId,
                                    message_id: messageId,
                                    parse_mode: "HTML",
                                    reply_markup: {
                                        inline_keyboard: [[
                                            {text: "Send to Anki", callback_data: "send_to_anki"},
                                            {text: "Cancel", callback_data: "cancel_preview"}
                                        ]]
                                    }
                                }
                            ).catch(() => {})
                        }
                    } else {
                        console.log(err)
                        await sendTempMessage(chatId, "Import failed. Please try again.")
                        await updateQueueMessage(chatId, userId)
                    }
                    await bot.answerCallbackQuery(q.id)
                } finally {
                    importInProgress.delete(userId)
                }
                break

            case "get_csv": {
                const cards = pendingCards.get(userId)
                if (!cards) {
                    await bot.answerCallbackQuery(q.id, {text: "Session expired — regenerate cards first"})
                    await updateQueueMessage(chatId, userId)
                    return
                }
                const stream = Readable.from(Buffer.from(generateCSV(cards), "utf-8"))
                await bot.sendDocument(chatId, stream, {}, {filename: "vocabulary.csv", contentType: "text/csv"})
                await bot.editMessageReplyMarkup(
                    {inline_keyboard: [[
                        {text: "Get CSV", callback_data: "get_csv"},
                        {text: "Get text", callback_data: "get_text"},
                        {text: "Done", callback_data: "done"}
                    ]]},
                    {chat_id: chatId, message_id: messageId}
                ).catch(() => {})
                await bot.answerCallbackQuery(q.id)
                break
            }

            case "get_text": {
                const cards = pendingCards.get(userId)
                if (!cards) {
                    await bot.answerCallbackQuery(q.id, {text: "Session expired — regenerate cards first"})
                    await updateQueueMessage(chatId, userId)
                    return
                }
                await bot.sendMessage(chatId, generateText(cards))
                await bot.editMessageReplyMarkup(
                    {inline_keyboard: [[
                        {text: "Get CSV", callback_data: "get_csv"},
                        {text: "Get text", callback_data: "get_text"},
                        {text: "Done", callback_data: "done"}
                    ]]},
                    {chat_id: chatId, message_id: messageId}
                ).catch(() => {})
                await bot.answerCallbackQuery(q.id)
                break
            }

            case "done": {
                pendingCards.delete(userId)
                await clearQueue(userId)
                setQueueMessageId(userId, null)
                await bot.editMessageReplyMarkup(
                    {inline_keyboard: []},
                    {chat_id: chatId, message_id: messageId}
                )
                await bot.answerCallbackQuery(q.id)
                break
            }

            case "cancel_preview":
                pendingCards.delete(userId)
                await bot.answerCallbackQuery(q.id)
                await updateQueueMessage(chatId, userId)
                break

            case "clear":
                items = await getAll(userId)
                if (!items.length) {
                    await bot.answerCallbackQuery(q.id, {text: "Queue is empty"})
                    return
                }
                await clearQueue(userId)
                pendingCards.delete(userId)
                setQueueMessageId(userId, messageId)
                await bot.editMessageText(
                    "Queue cleared",
                    {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: {inline_keyboard: []}
                    }
                )
                await bot.answerCallbackQuery(q.id, {text: "Queue cleared"})
                break
        }
    } catch (err) {
        console.log(err)
        await bot.answerCallbackQuery(q.id, {text: "Error occurred"})
        await updateQueueMessage(q.message.chat.id, q.from.id)
    }
})