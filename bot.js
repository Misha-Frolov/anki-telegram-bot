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

bot.on("message", msg => {
    const text = msg.text?.trim()
    if (!text) return
    if (text.startsWith("/")) return
    addText(text)
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
    const texts = await getAll()
    if (!texts.length) return
    const raw = texts.join("\n")

    /** @type {Card[]} */
    const cards = await generateCards(raw)
    const existing = await getExistingWords()

    const newCards =
        cards.filter(c =>
            !existing.has(
                c.word.toLowerCase()
            )
        )

    const audio = await Promise.all(
        newCards.map(c =>
            downloadAudio(c.word)
        )
    )

    const notes = newCards.map((c, i) => ({

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

    await bot.sendMessage(
        chatId,
        `Imported ${notes.length} cards`
    )
}

bot.onText(/\/import/, async msg => {
    await runImport(msg.chat.id)
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
        await runImport(
            q.message.chat.id
        )
        await bot.answerCallbackQuery(q.id)
    }
})
