import "dotenv/config"
import TelegramBot from "node-telegram-bot-api"

import {TELEGRAM_TOKEN, MODEL, ADMIN_ID} from "./config.js"
import {addText, getAll, clearQueue} from "./queue.js"
import {generateCards} from "./openai.js"
import {anki} from "./anki.js"
import {getCachedWords, addCachedWords, clearAnkiCache, getLLMCache, setLLMCache, getSetting, setSetting, addTokenUsage, getTokenUsage} from "./db.js"
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
    {command: "resync", description: "Rebuild Anki cache"},
    {command: "stats", description: "Show token usage and cost"},
]).catch(console.error)

let queueMessageId = null
let importInProgress = false
let pendingCards = null

function setQueueMessageId(id) {
    queueMessageId = id
    setSetting("queue_message_id", id ? String(id) : "0").catch(console.error)
}

getSetting("queue_message_id").then(val => {
    if (val && val !== "0") queueMessageId = Number(val)
}).catch(console.error)

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

async function updateQueueMessage(chatId, isAdmin = false) {
    const items = await getAll()
    if (!items.length) {
        const text = "Queue is empty"
        if (queueMessageId) {
            try {
                await bot.editMessageText(
                    text,
                    {
                        chat_id: chatId,
                        message_id: queueMessageId,
                        reply_markup: { inline_keyboard: [] }
                    }
                )
                return
            } catch {
                setQueueMessageId(null)
            }
        }
        const sent = await bot.sendMessage(chatId, text)
        setQueueMessageId(sent.message_id)
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
    try {
        const cached = await getCachedWords()
        allExist = items.every(t => cached.has(normalize(t)))
    } catch {}

    if (allExist) {
        message += `\n\n<b>All words already exist in Anki</b>`
    }

    const buttons = isAdmin
        ? [
            ...(!allExist ? [{text: "Generate flashcards", callback_data: "generate"}] : []),
            {text: "Clear queue", callback_data: "clear"}
          ]
        : []
    const markup = {
        parse_mode: "HTML",
        reply_markup: {inline_keyboard: buttons.length ? [buttons] : []}
    }
    if (queueMessageId) {
        try {
            await bot.editMessageText(message, {chat_id: chatId, message_id: queueMessageId, ...markup})
            return
        } catch {
            setQueueMessageId(null)
        }
    }
    const sent = await bot.sendMessage(chatId, message, markup)
    setQueueMessageId(sent.message_id)
}

bot.on("message", async msg => {
    setTimeout(() => {
        bot.deleteMessage(msg.chat.id, msg.message_id)
            .catch(() => {})
    }, AUTO_DELETE_MS)

    const text = msg.text?.trim()
    if (!text) return
    if (text.startsWith("/")) return

    const parts = splitInput(text)

    const existing = new Set(
        (await getAll()).map(normalize)
    )

    let added = 0
    for (const p of parts) {
        const n = normalize(p)
        if (existing.has(n)) {
            await sendTempMessage(msg.chat.id, `"${p}" already in queue`)
            continue
        }

        await addText(p)
        existing.add(n)
        added++
    }

    if (added) {
        await updateQueueMessage(msg.chat.id, msg.from.id === ADMIN_ID)
    }
})


bot.onText(/\/start/, async msg => {
    await sendTempMessage(msg.chat.id, "Send words or phrases")
    await updateQueueMessage(msg.chat.id, msg.from.id === ADMIN_ID)
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
    const {promptTokens, completionTokens} = await getTokenUsage()
    const cost = (promptTokens * PRICE_INPUT + completionTokens * PRICE_OUTPUT) / 1_000_000
    await sendTempMessage(
        msg.chat.id,
        `Tokens used:\nInput: ${promptTokens.toLocaleString()}\nOutput: ${completionTokens.toLocaleString()}\nCost: $${cost.toFixed(4)}`
    )
})

bot.onText(/\/clear/, async msg => {
    const items = await getAll()
    if (!items.length) {
        return
    }
    await clearQueue()
    setQueueMessageId(null)
    await updateQueueMessage(msg.chat.id, msg.from.id === ADMIN_ID)
})

function formatCardsPreview(cards) {
    const lines = cards.map(c => {
        const tags = c.tags.join("  ")
        return `<b>${c.word}</b> — ${c.translation}\n<i>${c.example}</i>\n${c.deck}  ${tags}`
    })
    return `Generated ${cards.length} card${cards.length !== 1 ? "s" : ""}:\n\n` + lines.join("\n\n")
}

bot.on("callback_query", async q => {

    const chatId = q.message.chat.id
    const messageId = q.message.message_id
    let items

    if (queueMessageId && messageId !== queueMessageId) {
        await bot.deleteMessage(chatId, messageId).catch(() => {})
        await bot.answerCallbackQuery(q.id, {text: "This message is outdated"})
        return
    }

    try {
        switch (q.data) {

            case "generate":
                if (q.from.id !== ADMIN_ID) {
                    await bot.answerCallbackQuery(q.id, {text: "Only the deck owner can generate cards."})
                    return
                }
                if (importInProgress) {
                    await bot.answerCallbackQuery(q.id, {text: "Import already running"})
                    return
                }
                items = await getAll()
                if (!items.length) {
                    await bot.answerCallbackQuery(q.id, {text: "Queue is empty"})
                    return
                }
                importInProgress = true
                await bot.editMessageText(
                    "Generating flashcards...",
                    {chat_id: chatId, message_id: messageId}
                )
                try {
                    const existing = await getCachedWords()
                    const missing = items.filter(t => !existing.has(normalize(t)))
                    if (!missing.length) {
                        await clearQueue()
                        setQueueMessageId(null)
                        pendingCards = null
                        await bot.editMessageText(
                            "All words already exist in Anki",
                            {chat_id: chatId, message_id: messageId, reply_markup: {inline_keyboard: []}}
                        )
                        await bot.answerCallbackQuery(q.id)
                        break
                    }
                    const raw = missing.join("\n")
                    let cards = await getLLMCache(raw)
                    if (!cards) {
                        const result = await generateCards(raw)
                        cards = result.cards
                        await setLLMCache(raw, cards)
                        await addTokenUsage(result.usage.prompt_tokens, result.usage.completion_tokens).catch(console.error)
                    }
                    if (!cards.length) {
                        pendingCards = null
                        await bot.editMessageText(
                            "No vocabulary detected",
                            {chat_id: chatId, message_id: messageId, reply_markup: {inline_keyboard: []}}
                        )
                        await bot.answerCallbackQuery(q.id)
                        break
                    }
                    pendingCards = cards
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
                    )
                    await bot.answerCallbackQuery(q.id)
                } catch (err) {
                    pendingCards = null
                    if (err.code === "insufficient_quota") {
                        await sendTempMessage(chatId, "OpenAI API quota exceeded. Check billing.")
                    } else if (err.message === "INVALID_JSON_FROM_LLM") {
                        await sendTempMessage(chatId, "Failed to parse AI response. Please try again.")
                    } else if (err.message?.startsWith("INVALID_DECK_FROM_LLM")) {
                        await sendTempMessage(chatId, "AI returned an unknown deck. Please try again.")
                    } else {
                        console.log(err)
                    }
                    await updateQueueMessage(chatId, true)
                    await bot.answerCallbackQuery(q.id, {text: "Error occurred"})
                } finally {
                    importInProgress = false
                }
                break

            case "send_to_anki":
                if (q.from.id !== ADMIN_ID) {
                    await bot.answerCallbackQuery(q.id, {text: "Only the deck owner can import cards."})
                    return
                }
                if (importInProgress) {
                    await bot.answerCallbackQuery(q.id, {text: "Import already running"})
                    return
                }
                if (!pendingCards) {
                    await bot.answerCallbackQuery(q.id, {text: "Session expired — regenerate cards first"})
                    await updateQueueMessage(chatId, true)
                    return
                }
                importInProgress = true
                await bot.editMessageText(
                    "Importing...",
                    {chat_id: chatId, message_id: messageId, reply_markup: {inline_keyboard: []}}
                )
                try {
                    const cards = pendingCards
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
                    await clearQueue()
                    pendingCards = null
                    setQueueMessageId(null)
                    await bot.editMessageText(
                        `Imported ${notes.length} card${notes.length !== 1 ? "s" : ""}:\n\n${cards.map(c => c.word).join("\n")}`,
                        {chat_id: chatId, message_id: messageId}
                    )
                    await bot.answerCallbackQuery(q.id)
                } catch (err) {
                    if (err.code === "ECONNREFUSED") {
                        await sendTempMessage(chatId, "Anki is not running. Start Anki and try again.")
                    } else {
                        console.log(err)
                        await sendTempMessage(chatId, "Import failed. Please try again.")
                    }
                    await updateQueueMessage(chatId, true)
                    await bot.answerCallbackQuery(q.id)
                } finally {
                    importInProgress = false
                }
                break

            case "cancel_preview":
                pendingCards = null
                await bot.answerCallbackQuery(q.id)
                await updateQueueMessage(chatId, true)
                break

            case "clear":
                items = await getAll()
                if (!items.length) {
                    await bot.answerCallbackQuery(q.id, {text: "Queue is empty"})
                    return
                }
                await clearQueue()
                pendingCards = null
                setQueueMessageId(messageId)
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
        await updateQueueMessage(q.message.chat.id, q.from.id === ADMIN_ID)
    }
})
