import "dotenv/config"
import TelegramBot from "node-telegram-bot-api"

import {TELEGRAM_TOKEN, MODEL} from "./config.js"
import {addText, getAll, clearQueue} from "./queue.js"
import {generateCards} from "./openai.js"
import {anki} from "./anki.js"
import {getCachedWords, addCachedWords, clearAnkiCache, getLLMCache, setLLMCache} from "./db.js"
import {downloadAudio} from "./tts.js"

const bot = new TelegramBot(
    TELEGRAM_TOKEN,
    {polling: true}
)

ensureAnkiCache().catch(console.error)

bot.setMyCommands([
    {command: "start", description: "Start bot"},
    {command: "import", description: "Import queued words to Anki"},
    {command: "clear", description: "Clear queue"},
    {command: "resync", description: "Rebuild Anki cache"}
]).catch(console.error)

let queueMessageId = null
let importInProgress = false

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

async function updateQueueMessage(chatId) {
    const items = await getAll()
    if (!items.length) {
        if (queueMessageId) {
            try {
                await bot.editMessageText(
                    "Queue is empty",
                    {
                        chat_id: chatId,
                        message_id: queueMessageId,
                        reply_markup: {inline_keyboard: []}
                    }
                )
            } catch {
                queueMessageId = null
            }
        } else {
            const sent = await bot.sendMessage(chatId, "Queue is empty")
            queueMessageId = sent.message_id
        }
        return
    }

    const limit = 5
    const preview = items
        .slice(0, limit)
        .map((w, i) => `${i + 1}. ${w}`)
        .join("\n")
    let message =
        `Queued words: ${items.length}\n\n${preview}`
    if (items.length > limit) {
        message += `\n...and ${items.length - limit} more`
    }
    const markup = {
        reply_markup: {
            inline_keyboard: [[
                {text: "Import to Anki", callback_data: "import"},
                {text: "Clear queue", callback_data: "clear"}
            ]]
        }
    }
    if (queueMessageId) {
        try {
            await bot.editMessageText(
                message,
                {
                    chat_id: chatId,
                    message_id: queueMessageId,
                    ...markup
                }
            )
        } catch {
            queueMessageId = null
        }
    } else {
        const sent = await bot.sendMessage(chatId, message, markup)
        queueMessageId = sent.message_id
    }
}

bot.on("message", async msg => {
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
            const warn = await bot.sendMessage(msg.chat.id, `"${p}" already in queue`)
            setTimeout(() => {
                bot.deleteMessage(msg.chat.id, warn.message_id)
                    .catch(() => {
                    })
            }, 3000)
            continue
        }

        await addText(p)
        existing.add(n)
        added++
    }

    if (added) {
        await updateQueueMessage(msg.chat.id)
    }
})

/**
 * @typedef {Object} Card
 * @property {string} word
 * @property {string} translation
 * @property {string} example
 * @property {string} deck
 * @property {string[]} tags
 */
async function runImport(chatId) {

    if (importInProgress) {
        await bot.sendMessage(chatId, "Import already in progress")
        return
    }

    importInProgress = true

    try {
        const texts = await getAll()
        if (!texts.length) return

        const existing = await getCachedWords()
        const missing = texts.filter(t => !existing.has(normalize(t)))

        if (!missing.length) {
            await bot.sendMessage(chatId, "All words already exist in Anki")
            await clearQueue()
            queueMessageId = null
            return
        }

        const raw = missing.join("\n")
        let cards = await getLLMCache(raw)
        if (!cards) {
            cards = await generateCards(raw)
            await setLLMCache(raw, cards)
        }

        if (!cards.length) {
            await bot.sendMessage(chatId, "No vocabulary detected")
            return
        }
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
        queueMessageId = null

        await bot.sendMessage(chatId, `Imported ${notes.length} cards`)
    } catch (err) {
        if (err.code === "insufficient_quota") {
            await bot.sendMessage(chatId, "OpenAI API quota exceeded. Check billing.")
            await updateQueueMessage(chatId)
            return
        }
        if (err.message === "INVALID_JSON_FROM_LLM") {
            await bot.sendMessage(chatId, "Failed to parse AI response. Please try again.")
            await updateQueueMessage(chatId)
            return
        }
        console.log(err)
        await updateQueueMessage(chatId)
    } finally {
        importInProgress = false
    }
}

bot.onText(/\/import/, async msg => {
    try {
        await runImport(msg.chat.id)
    } catch (err) {
        console.log(err)
    }
})

bot.onText(/\/start/, async msg => {
    await bot.sendMessage(msg.chat.id, "Send words or phrases")
    await updateQueueMessage(msg.chat.id)
})

bot.onText(/\/resync/, async msg => {
    try {
        await bot.sendMessage(msg.chat.id, "Rebuilding Anki cache...")
        const ids = await anki(
            "findNotes",
            {query: "Word:*"}
        )
        if (!ids.length) {
            await bot.sendMessage(msg.chat.id, "No cards found in Anki")
            return
        }
        const notes = await anki(
            "notesInfo",
            {notes: ids}
        )
        const words = notes.map(n => normalize(n.fields.Word.value))
        await clearAnkiCache()
        await addCachedWords(words)
        await bot.sendMessage(msg.chat.id, `Cache rebuilt: ${words.length} words`)
    } catch (err) {
        console.log(err)
        await bot.sendMessage(msg.chat.id, "Failed to rebuild cache")
    }
})

bot.onText(/\/clear/, async msg => {
    await clearQueue()
    queueMessageId = null
    await updateQueueMessage(msg.chat.id)
})

bot.on("callback_query", async q => {

    const chatId = q.message.chat.id
    const messageId = q.message.message_id

    try {
        switch (q.data) {

            case "import":
                if (importInProgress) {
                    await bot.answerCallbackQuery(q.id, {text: "Import already running"})
                    return
                }
                await bot.editMessageText(
                    "Importing...",
                    {
                        chat_id: chatId,
                        message_id: messageId
                    }
                )
                await runImport(chatId)
                await bot.answerCallbackQuery(q.id)
                break

            case "clear":
                await clearQueue()
                queueMessageId = null
                await bot.editMessageText(
                    "Queue cleared",
                    {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: {
                            inline_keyboard: [[
                                {text: "Import to Anki", callback_data: "import"},
                                {text: "Clear queue", callback_data: "clear"}
                            ]]
                        }
                    }
                )
                await bot.answerCallbackQuery(q.id, {text: "Queue cleared"})
                break
        }
    } catch (err) {
        console.log(err)
        await bot.answerCallbackQuery(q.id, {text: "Error occurred"})
        await updateQueueMessage(q.message.chat.id)
    }
})
