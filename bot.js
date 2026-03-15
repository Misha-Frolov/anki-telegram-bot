import "dotenv/config"
import TelegramBot from "node-telegram-bot-api"

import {TELEGRAM_TOKEN, MODEL} from "./config.js"
import {addText, getAll, clearQueue} from "./queue.js"
import {generateCards} from "./openai.js"
import {getExistingWords, anki} from "./anki.js"
import {downloadAudio} from "./tts.js"

const bot = new TelegramBot(
    TELEGRAM_TOKEN,
    {polling: true}
)

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

bot.setMyCommands([
    {command: "start", description: "Start bot"},
    {command: "import", description: "Import queued words to Anki"}
])

let queueMessageId = null
let importInProgress = false

bot.on("message", async msg => {
    const text = msg.text?.trim()
    if (!text) return
    if (text.startsWith("/")) return

    const parts = splitInput(text)
    const existing = await getAll()
    const existingNorm = new Set(existing.map(normalize))

    let added = 0
    for (const p of parts) {
        const n = normalize(p)
        if (existingNorm.has(n)) {
            const warn = await bot.sendMessage(msg.chat.id, `"${p}" already in queue`)
            setTimeout(() => {
                bot.deleteMessage(msg.chat.id, warn.message_id)
                    .catch(() => {
                    })
            }, 3000)
            continue
        }

        addText(p)
        existingNorm.add(n)
        added++
    }

    // если ничего не добавилось, не обновляем UI
    if (added === 0) return

    const updated = await getAll()
    const message = `Queued words: ${updated.length}`
    const markup = {
        reply_markup: {
            inline_keyboard: [[
                {
                    text: "Import to Anki",
                    callback_data: "import"
                }
            ]]
        }
    }

    if (queueMessageId) {
        await bot.editMessageText(
            message,
            {
                chat_id: msg.chat.id,
                message_id: queueMessageId,
                ...markup
            }
        )

    } else {
        const sent = await bot.sendMessage(
            msg.chat.id,
            message,
            markup
        )
        queueMessageId = sent.message_id
    }
})

    async function mapLimit(arr, limit, fn) {
        const result = []
        const executing = []
        for (const item of arr) {
            const p = Promise.resolve().then(() => fn(item))
            result.push(p)
            if (limit <= arr.length) {
                const e = p.then(() => executing.splice(executing.indexOf(e),1))
                executing.push(e)
                if (executing.length >= limit) {
                    await Promise.race(executing)
                }
            }
        }
        return Promise.all(result)
    }

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

        const existing = await getExistingWords()
        const missing = texts.filter(t => !existing.has(normalize(t)))

        if (!missing.length) {
            await bot.sendMessage(chatId, "All words already exist in Anki")
            clearQueue()
            queueMessageId = null
            return
        }

        const raw = missing.join("\n")
        let cards = await generateCards(raw)
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

        clearQueue()
        queueMessageId = null

        await bot.sendMessage(chatId, `Imported ${notes.length} cards`)

    } catch (err) {
        if (err.code === "insufficient_quota") {
            await bot.sendMessage(chatId, "OpenAI API quota exceeded. Check billing.")
            return
        }
        if (err.message === "INVALID_JSON_FROM_LLM") {
            await bot.sendMessage(chatId, "Failed to parse AI response. Please try again.")
            return
        }
        throw err
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

bot.onText(/\/start/, msg => {
    bot.sendMessage(
        msg.chat.id,
        "Send words or phrases",
        {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: "Import to Anki",
                            callback_data: "import"
                        }
                    ]
                ]
            }
        }
    )
})

bot.on("callback_query", async q => {
    if (q.data === "import") {
        if (importInProgress) {
            await bot.answerCallbackQuery(q.id, {
                text: "Import already running"
            })
            return
        }
        try {
            await bot.editMessageText(
                "Importing...",
                {
                    chat_id: q.message.chat.id,
                    message_id: q.message.message_id
                }
            )
            await runImport(q.message.chat.id)
            await bot.answerCallbackQuery(q.id)
        } catch (err) {
            console.log(err)
        }
    }
})
