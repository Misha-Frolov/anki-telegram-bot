import "dotenv/config"
import TelegramBot from "node-telegram-bot-api"
import {appendFileSync} from "fs"

import {TELEGRAM_TOKEN, MODEL, ADMIN_ID, TEACHER_IDS, TRANSLATE_ENGINE} from "./config.js"
import {
    addText, getAll, clearQueue,
    getCachedWords, addCachedWords, clearAnkiCache,
    getLLMCache, setLLMCache,
    getUserSetting, setUserSetting,
    addTokenUsage, getTokenUsage,
    addGoogleTranslateWords,
    getUserTokenUsage, getGoogleTranslateWords, getAllUsersWithStats,
    getAnkiWordsCount, getAnkiWordsPage, getRandomAnkiWords, getLastAnkiWords
} from "./db.js"
import {Readable} from "stream"
import {generateCards} from "./openai.js"
import {translateWords} from "./translate.js"
import {generateCSV, generateText} from "./csv.js"
import {anki} from "./anki.js"
import {downloadAudio} from "./tts.js"

function logError(context, err) {
    const ts = new Date().toISOString()
    const text = `[${ts}] [${context}] ${err?.stack || err}\n`
    try { appendFileSync("errors.log", text) } catch {}
    console.error(text.trim())
}

const LANGUAGES = [
    "Afrikaans", "Albanian", "Amharic", "Arabic", "Armenian", "Azerbaijani",
    "Basque", "Belarusian", "Bengali", "Bosnian", "Bulgarian", "Catalan",
    "Cebuano", "Chinese", "Croatian", "Czech", "Danish", "Dutch",
    "English", "Esperanto", "Estonian", "Filipino", "Finnish", "French",
    "Galician", "Georgian", "German", "Greek", "Gujarati", "Haitian Creole",
    "Hausa", "Hebrew", "Hindi", "Hungarian", "Icelandic", "Igbo",
    "Indonesian", "Irish", "Italian", "Japanese", "Javanese", "Kannada",
    "Kazakh", "Khmer", "Korean", "Kurdish", "Kyrgyz", "Lao",
    "Latin", "Latvian", "Lithuanian", "Macedonian", "Malagasy", "Malay",
    "Malayalam", "Maltese", "Maori", "Marathi", "Mongolian", "Myanmar",
    "Nepali", "Norwegian", "Pashto", "Persian", "Polish", "Portuguese",
    "Punjabi", "Romanian", "Samoan", "Serbian", "Sinhala",
    "Slovak", "Slovenian", "Somali", "Spanish", "Swahili", "Swedish",
    "Tajik", "Tamil", "Telugu", "Thai", "Turkish", "Turkmen",
    "Ukrainian", "Urdu", "Uzbek", "Vietnamese", "Welsh", "Yoruba", "Zulu",
]

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
]).catch(console.error)

bot.setMyCommands([
    {command: "start", description: "Start bot"},
    {command: "clear", description: "Clear queue"},
    {command: "stats", description: "Show token usage and cost"},
    {command: "resync", description: "Rebuild Anki cache"},
], {scope: {type: "chat", chat_id: ADMIN_ID}}).catch(console.error)

for (const teacherId of TEACHER_IDS) {
    bot.setMyCommands([
        {command: "start", description: "Start bot"},
        {command: "clear", description: "Clear queue"},
    ], {scope: {type: "chat", chat_id: teacherId}}).catch(console.error)
}

// Per-user in-memory state
const queueMessageIds = new Map()    // userId → messageId
const importInProgress = new Set()   // userId
const pendingCards = new Map()       // userId → cards[]
const pendingSkipped = new Map()     // userId → string[]
const startMessageIds = new Map()          // userId → messageId
const langPickerMessageIds = new Map()     // userId → messageId
const quizletInstructionIds = new Map()    // userId → messageId
const awaitingLangInput = new Map()        // userId → {promptMsgId, onboarding}
const teacherModePickerIds = new Map()     // userId → messageId

const PICKER_LANGUAGES = [
    ["English", "Spanish", "French", "German"],
    ["Italian", "Portuguese", "Turkish", "Arabic"],
    ["Chinese", "Japanese", "Korean", "Hindi"],
    ["Polish", "Ukrainian", "Indonesian", "Other →"],
]

async function sendLanguagePicker(chatId, userId) {
    const keyboard = PICKER_LANGUAGES.map(row =>
        row.map(lang => ({text: lang, callback_data: `lang_pick:${lang}`}))
    )
    const sent = await bot.sendMessage(chatId, "Choose your language:", {
        reply_markup: {inline_keyboard: keyboard}
    })
    langPickerMessageIds.set(userId, sent.message_id)
}

async function sendStartMessage(chatId, userId) {
    const isAdmin = userId === ADMIN_ID
    const lang = await getUserSetting(userId, "lang").catch(() => null) || "English"
    const text = isAdmin
        ? "Send words or phrases"
        : `Send words or phrases in ${lang} or change language: /lang <language>`
    const sent = await bot.sendMessage(chatId, text)
    startMessageIds.set(userId, sent.message_id)
}

async function sendTeacherStartMessage(chatId, userId) {
    const adminName = await getUserSetting(ADMIN_ID, "name").catch(() => null) || "Admin"
    const sent = await bot.sendMessage(chatId,
        `Send words or phrases for ${adminName}`,
        {reply_markup: {inline_keyboard: [[
            {text: "📚 Browse Anki words", callback_data: "browse_menu"}
        ]]}}
    )
    startMessageIds.set(userId, sent.message_id)
}

function formatWordList(words) {
    if (!words.length) return "<i>List is empty</i>"
    return words.map(w =>
        w.translation
            ? `<b>${escapeHtml(w.word)}</b> — ${escapeHtml(w.translation)}`
            : `<b>${escapeHtml(w.word)}</b>`
    ).join("\n")
}

// Returns true if language was saved successfully
async function trySetLanguage(chatId, userId, raw) {
    const normalized = raw.replace(/\b\w/g, c => c.toUpperCase())

    if (LANGUAGES.includes(normalized)) {
        await setUserSetting(userId, "lang", normalized)
        await sendTempMessage(chatId, `Language set to ${normalized} ✓`)
        return true
    }

    const lower = normalized.toLowerCase()
    const matches = LANGUAGES.filter(l => l.toLowerCase().startsWith(lower))

    if (matches.length === 1) {
        await setUserSetting(userId, "lang", matches[0])
        await sendTempMessage(chatId, `Language set to ${matches[0]} ✓`)
        return true
    }
    if (matches.length > 1) {
        await sendTempMessage(chatId, `Multiple matches: ${matches.join(", ")}`)
        return false
    }

    await sendTempMessage(chatId, `Unknown language: "${raw}". Please enter a valid language name.`)
    return false
}

// Restore queue message IDs from DB on startup for admin and personal-mode teachers
getUserSetting(ADMIN_ID, "queue_message_id").then(val => {
    if (val && val !== "0") queueMessageIds.set(ADMIN_ID, Number(val))
}).catch(console.error)

for (const tid of TEACHER_IDS) {
    getUserSetting(tid, "teacher_mode").then(mode => {
        if (mode !== "personal") return
        return getUserSetting(tid, "queue_message_id").then(val => {
            if (val && val !== "0") queueMessageIds.set(tid, Number(val))
        })
    }).catch(console.error)
}

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
        const pairs = notes.map(n => ({
            word: normalize(n.fields.Word.value),
            translation: n.fields.Translation?.value || ""
        }))
        await addCachedWords(pairs.map(p => p.word), pairs.map(p => p.translation))
        console.log(`Cached ${pairs.length} words`)
    } catch (err) {
        logError("ensureAnkiCache", err)
    }
}

async function updateQueueMessage(chatId, userId, queueUserId = null) {
    const isTeacherView = queueUserId !== null
    const effectiveUserId = isTeacherView ? queueUserId : userId
    const isAdmin = userId === ADMIN_ID

    // Restore queue message ID from DB only for non-teacher views
    let queueMsgId = queueMessageIds.get(userId)
    if (!queueMsgId && !isTeacherView) {
        const stored = await getUserSetting(userId, "queue_message_id").catch(() => null)
        if (stored && stored !== "0") {
            queueMsgId = Number(stored)
            queueMessageIds.set(userId, queueMsgId)
        }
    }

    const items = await getAll(effectiveUserId)
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
            if (isTeacherView) {
                queueMessageIds.delete(userId)
            } else {
                setQueueMessageId(userId, null)
            }
        }
        const sent = await bot.sendMessage(chatId, text)
        if (isTeacherView) {
            queueMessageIds.set(userId, sent.message_id)
        } else {
            setQueueMessageId(userId, sent.message_id)
        }
        return
    }

    const limit = 5
    const preview = items
        .slice(0, limit)
        .map((w, i) => `${i + 1}. <b>${escapeHtml(w)}</b>`)
        .join("\n")

    let header
    if (isTeacherView) {
        const adminName = await getUserSetting(effectiveUserId, "name").catch(() => null) || "Admin"
        header = `Queued words for ${escapeHtml(adminName)}: ${items.length}`
    } else {
        header = `Queued words: ${items.length}`
    }
    let message = `${header}\n\n${preview}`
    if (items.length > limit) {
        message += `\n...and ${items.length - limit} more`
    }

    let markup
    if (isTeacherView) {
        markup = {parse_mode: "HTML", reply_markup: {inline_keyboard: []}}
    } else {
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
        markup = {parse_mode: "HTML", reply_markup: {inline_keyboard: [buttons]}}
    }

    if (queueMsgId) {
        try {
            const ok = await bot.editMessageText(message, {chat_id: chatId, message_id: queueMsgId, ...markup})
            if (ok) return
        } catch {}
        if (isTeacherView) {
            queueMessageIds.delete(userId)
        } else {
            setQueueMessageId(userId, null)
        }
    }
    const sent = await bot.sendMessage(chatId, message, markup)
    if (isTeacherView) {
        queueMessageIds.set(userId, sent.message_id)
    } else {
        setQueueMessageId(userId, sent.message_id)
    }
}

function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function formatCardsPreview(cards, skipped = []) {
    const lines = cards.map(c => {
        let line = `<b>${escapeHtml(c.word)}</b> — ${escapeHtml(c.translation)}`
        if (c.example) line += `\n<i>${escapeHtml(c.example)}</i>`
        if (c.deck) line += `\n${c.deck}  ${c.tags?.join("  ") || ""}`
        return line
    })
    const sep = cards.some(c => c.example) ? "\n\n" : "\n"
    let text = `Generated ${cards.length} card${cards.length !== 1 ? "s" : ""}:\n\n` + lines.join(sep)
    if (skipped.length) {
        text += `\n\n<i>Skipped (${skipped.length}): ${skipped.map(escapeHtml).join(", ")}</i>`
    }
    return text
}

bot.on("message", async msg => {
    const text = msg.text?.trim()

    if (!text || text.startsWith("/")) {
        setTimeout(() => bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {}), AUTO_DELETE_MS)
        return
    }

    const userId = msg.from.id
    const chatId = msg.chat.id

    // Store display name for stats (fire-and-forget)
    const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ")
    if (name) setUserSetting(userId, "name", name).catch(() => {})

    // Awaiting language input (from picker "Other →" or /lang without args)
    if (awaitingLangInput.has(userId)) {
        const {promptMsgId, onboarding} = awaitingLangInput.get(userId)
        awaitingLangInput.delete(userId)
        bot.deleteMessage(chatId, promptMsgId).catch(() => {})
        bot.deleteMessage(chatId, msg.message_id).catch(() => {})
        const ok = await trySetLanguage(chatId, userId, text)
        if (onboarding) {
            if (ok) {
                await sendStartMessage(chatId, userId)
                await updateQueueMessage(chatId, userId)
            } else {
                await sendLanguagePicker(chatId, userId)
            }
        }
        return
    }

    const isTeacher = TEACHER_IDS.includes(userId)
    const teacherMode = isTeacher ? await getUserSetting(userId, "teacher_mode") : null
    const isTeacherMode = isTeacher && teacherMode !== "personal"
    const targetUserId = isTeacherMode ? ADMIN_ID : userId

    const parts = splitInput(text)

    const existing = new Set(
        (await getAll(targetUserId)).map(normalize)
    )

    let ankiWords = new Set()
    if (targetUserId === ADMIN_ID) {
        try { ankiWords = await getCachedWords() } catch {}
    }

    let added = 0
    const skippedAnki = []
    for (const p of parts) {
        const n = normalize(p)
        if (existing.has(n)) {
            if (!isTeacherMode) await sendTempMessage(chatId, `"${p}" already in queue`)
            continue
        }
        if (ankiWords.has(n)) {
            skippedAnki.push(p)
            continue
        }
        await addText(targetUserId, p)
        existing.add(n)
        added++
    }

    if (skippedAnki.length) {
        const words = skippedAnki.map(w => `"${w}"`).join(", ")
        await sendTempMessage(chatId, `Already in Anki: ${words}`)
    }

    if (added > 0) {
        const startMsgId = startMessageIds.get(userId)
        if (startMsgId) {
            bot.deleteMessage(chatId, startMsgId).catch(() => {})
            startMessageIds.delete(userId)
        }
        bot.deleteMessage(chatId, msg.message_id).catch(() => {})
        if (isTeacherMode) {
            await updateQueueMessage(chatId, userId, ADMIN_ID)
        } else {
            await updateQueueMessage(chatId, userId)
        }
    } else {
        setTimeout(() => bot.deleteMessage(chatId, msg.message_id).catch(() => {}), AUTO_DELETE_MS)
    }
})


bot.onText(/\/start/, async msg => {
    const userId = msg.from.id
    const isAdmin = userId === ADMIN_ID
    const isTeacher = TEACHER_IDS.includes(userId)

    if (isTeacher) {
        const sent = await bot.sendMessage(msg.chat.id, "Choose mode:", {
            reply_markup: {inline_keyboard: [[
                {text: "👩‍🏫 Teacher",  callback_data: "teacher_mode:teacher"},
                {text: "👤 Personal", callback_data: "teacher_mode:personal"}
            ]]}
        })
        teacherModePickerIds.set(userId, sent.message_id)
        return
    }

    if (!isAdmin) {
        const lang = await getUserSetting(userId, "lang").catch(() => null)
        if (!lang) {
            await sendLanguagePicker(msg.chat.id, userId)
            return
        }
    }
    await sendStartMessage(msg.chat.id, userId)
    await updateQueueMessage(msg.chat.id, userId)
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
        const pairs = notes.map(n => ({
            word: normalize(n.fields.Word.value),
            translation: n.fields.Translation?.value || ""
        }))
        await clearAnkiCache()
        await addCachedWords(pairs.map(p => p.word), pairs.map(p => p.translation))
        await sendTempMessage(msg.chat.id, `Cache rebuilt: ${pairs.length} words`)
    } catch (err) {
        const isConnErr = err.type === "system" || err.code === "ECONNREFUSED"
        if (isConnErr) {
            console.log("[resync] Anki unavailable")
        } else {
            logError("resync", err)
        }
        await sendTempMessage(msg.chat.id, isConnErr ? "Anki is not running" : "Failed to rebuild cache")
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
    if (userId === ADMIN_ID) return
    const match = msg.text.match(/^\/lang\s+(.+)$/)
    if (!match) {
        const current = await getUserSetting(userId, "lang") || "English"
        const prompt = await bot.sendMessage(msg.chat.id,
            `Current language: ${current}\nType a new language name:`,
            {reply_markup: {force_reply: true, input_field_placeholder: "e.g. Turkish, French, Arabic"}}
        )
        awaitingLangInput.set(userId, {promptMsgId: prompt.message_id, onboarding: false})
        return
    }

    await trySetLanguage(msg.chat.id, userId, match[1].trim())
})

bot.on("callback_query", async q => {

    const chatId = q.message.chat.id
    const messageId = q.message.message_id
    const userId = q.from.id
    let items

    // Teacher mode picker — handle before the outdated-message guard
    if (q.data === "teacher_mode:teacher" || q.data === "teacher_mode:personal") {
        const mode = q.data === "teacher_mode:teacher" ? "teacher" : "personal"
        await bot.deleteMessage(chatId, messageId).catch(() => {})
        teacherModePickerIds.delete(userId)
        await bot.answerCallbackQuery(q.id)
        await setUserSetting(userId, "teacher_mode", mode)
        if (mode === "teacher") {
            await sendTeacherStartMessage(chatId, userId)
        } else {
            const lang = await getUserSetting(userId, "lang")
            if (!lang) {
                await sendLanguagePicker(chatId, userId)
                return
            }
            await sendStartMessage(chatId, userId)
            await updateQueueMessage(chatId, userId)
        }
        return
    }

    // Browse Anki words — handle before the outdated-message guard
    if (q.data === "browse_menu") {
        await bot.answerCallbackQuery(q.id)
        const count = await getAnkiWordsCount()
        await bot.sendMessage(chatId,
            `Words in Anki: ${count}. What to show?`,
            {reply_markup: {inline_keyboard: [[
                {text: "Full list",  callback_data: "browse_all:0"},
                {text: "10 random",  callback_data: "browse_random"},
                {text: "10 latest",  callback_data: "browse_last"},
            ]]}}
        )
        return
    }

    if (q.data === "browse_random" || q.data === "browse_last") {
        const words = q.data === "browse_random"
            ? await getRandomAnkiWords(10)
            : await getLastAnkiWords(10)
        await bot.editMessageText(formatWordList(words),
            {chat_id: chatId, message_id: messageId, parse_mode: "HTML"})
        await bot.answerCallbackQuery(q.id)
        return
    }

    if (q.data.startsWith("browse_all:")) {
        const PAGE = 30
        const offset = parseInt(q.data.slice("browse_all:".length)) || 0
        const [words, total] = await Promise.all([getAnkiWordsPage(offset, PAGE), getAnkiWordsCount()])
        const hasNext = offset + PAGE < total
        await bot.editMessageText(
            formatWordList(words) + `\n\n<i>${offset + words.length} / ${total}</i>`,
            {
                chat_id: chatId, message_id: messageId,
                parse_mode: "HTML",
                reply_markup: {inline_keyboard: hasNext
                    ? [[{text: "Next →", callback_data: `browse_all:${offset + PAGE}`}]]
                    : []}
            }
        )
        await bot.answerCallbackQuery(q.id)
        return
    }

    // Quizlet instruction dismiss — handle before the outdated-message guard
    if (q.data === "done_quizlet") {
        await bot.deleteMessage(chatId, messageId).catch(() => {})
        quizletInstructionIds.delete(userId)
        const previewMsgId = queueMessageIds.get(userId)
        if (previewMsgId) {
            await bot.editMessageReplyMarkup(
                {inline_keyboard: []},
                {chat_id: chatId, message_id: previewMsgId}
            ).catch(() => {})
        }
        pendingCards.delete(userId)
        pendingSkipped.delete(userId)
        await clearQueue(userId)
        setQueueMessageId(userId, null)
        await bot.answerCallbackQuery(q.id)
        return
    }

    // Language picker — handle before the outdated-message guard
    if (q.data.startsWith("lang_pick:")) {
        const raw = q.data.slice("lang_pick:".length)
        await bot.deleteMessage(chatId, messageId).catch(() => {})
        langPickerMessageIds.delete(userId)
        await bot.answerCallbackQuery(q.id)
        if (raw === "Other →") {
            const prompt = await bot.sendMessage(chatId, "Type your language name:", {
                reply_markup: {force_reply: true, input_field_placeholder: "e.g. Arabic, Hindi, Swedish"}
            })
            awaitingLangInput.set(userId, {promptMsgId: prompt.message_id, onboarding: true})
            return
        }
        await setUserSetting(userId, "lang", raw)
        await sendStartMessage(chatId, userId)
        await updateQueueMessage(chatId, userId)
        return
    }

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

                    let inputWords
                    if (isAdmin) {
                        const existing = await getCachedWords()
                        const missing = items.filter(t => !existing.has(normalize(t)))
                        if (!missing.length) {
                            await clearQueue(userId)
                            setQueueMessageId(userId, null)
                            pendingCards.delete(userId)
                            pendingSkipped.delete(userId)
                            await bot.editMessageText(
                                "All words already exist in Anki",
                                {chat_id: chatId, message_id: messageId, reply_markup: {inline_keyboard: []}}
                            )
                            await bot.answerCallbackQuery(q.id)
                            break
                        }
                        inputWords = missing
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
                        inputWords = items
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

                    const cardWords = new Set(cards.map(c => normalize(c.word)))
                    const skipped = inputWords.filter(w => !cardWords.has(normalize(w)))

                    if (!cards.length) {
                        pendingCards.delete(userId)
                        pendingSkipped.delete(userId)
                        await bot.editMessageText(
                            "No vocabulary detected",
                            {chat_id: chatId, message_id: messageId, reply_markup: {inline_keyboard: []}}
                        )
                        await bot.answerCallbackQuery(q.id)
                        break
                    }

                    pendingCards.set(userId, cards)
                    pendingSkipped.set(userId, skipped)
                    const isAdminUser = userId === ADMIN_ID
                    const actionButtons = isAdminUser
                        ? [{text: "Send to Anki", callback_data: "send_to_anki"}]
                        : [
                            {text: "Get CSV", callback_data: "get_csv"},
                            {text: "For Quizlet", callback_data: "get_text"}
                          ]
                    await bot.editMessageText(
                        formatCardsPreview(cards, skipped),
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
                        logError("generate", err)
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
                    await addCachedWords(
                        cards.map(c => normalize(c.word)),
                        cards.map(c => c.translation)
                    )
                    await clearQueue(userId)
                    pendingCards.delete(userId)
                    pendingSkipped.delete(userId)
                    setQueueMessageId(userId, null)
                    await bot.editMessageText(
                        `Imported ${notes.length} card${notes.length !== 1 ? "s" : ""}:\n\n${cards.map(c => c.word).join("\n")}`,
                        {chat_id: chatId, message_id: messageId}
                    )
                    await bot.answerCallbackQuery(q.id)
                    anki("sync").catch(() => {})
                } catch (err) {
                    if (err.code === "ECONNREFUSED") {
                        await sendTempMessage(chatId, "Anki is not running. Start Anki and try again.")
                        const cards = pendingCards.get(userId)
                        if (cards) {
                            await bot.editMessageText(
                                formatCardsPreview(cards, pendingSkipped.get(userId) || []),
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
                        logError("send_to_anki", err)
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
                        {text: "For Quizlet", callback_data: "get_text"},
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
                const vocabText = generateText(cards)
                await bot.sendMessage(chatId, vocabText)
                const instrMsg = await bot.sendMessage(chatId,
                    "Copy the message above. In Quizlet tap Import → set separator Between term and definition to ; (semicolon) and Between cards to New line.",
                    {reply_markup: {inline_keyboard: [[
                        {text: "📋 Copy", copy_text: {text: vocabText}},
                        {text: "✓ Done", callback_data: "done_quizlet"}
                    ]]}}
                )
                quizletInstructionIds.set(userId, instrMsg.message_id)
                await bot.editMessageReplyMarkup(
                    {inline_keyboard: [[
                        {text: "Get CSV", callback_data: "get_csv"},
                        {text: "For Quizlet", callback_data: "get_text"},
                        {text: "Done", callback_data: "done"}
                    ]]},
                    {chat_id: chatId, message_id: messageId}
                ).catch(() => {})
                await bot.answerCallbackQuery(q.id)
                break
            }

            case "done": {
                const instrMsgId = quizletInstructionIds.get(userId)
                if (instrMsgId) {
                    await bot.deleteMessage(chatId, instrMsgId).catch(() => {})
                    quizletInstructionIds.delete(userId)
                }
                pendingCards.delete(userId)
                pendingSkipped.delete(userId)
                await clearQueue(userId)
                setQueueMessageId(userId, null)
                await bot.editMessageReplyMarkup(
                    {inline_keyboard: []},
                    {chat_id: chatId, message_id: messageId}
                )
                await bot.answerCallbackQuery(q.id)
                break
            }

            case "cancel_preview": {
                const instrId = quizletInstructionIds.get(userId)
                if (instrId) {
                    await bot.deleteMessage(chatId, instrId).catch(() => {})
                    quizletInstructionIds.delete(userId)
                }
                pendingCards.delete(userId)
                pendingSkipped.delete(userId)
                await bot.answerCallbackQuery(q.id)
                await updateQueueMessage(chatId, userId)
                break
            }

            case "clear":
                items = await getAll(userId)
                if (!items.length) {
                    await bot.answerCallbackQuery(q.id, {text: "Queue is empty"})
                    return
                }
                await clearQueue(userId)
                pendingCards.delete(userId)
                pendingSkipped.delete(userId)
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
        logError("callback", err)
        await bot.answerCallbackQuery(q.id, {text: "Error occurred"}).catch(() => {})
        await updateQueueMessage(q.message.chat.id, q.from.id).catch(() => {})
    }
})