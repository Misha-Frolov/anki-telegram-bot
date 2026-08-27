// Re-sorts the whole collection across the deck list in openai.js.
//
//   node reclassify.mjs           → asks GPT, writes moves.json, prints a summary
//   node reclassify.mjs --apply   → applies moves.json via changeDeck
//
// changeDeck keeps scheduling, so intervals and review history survive the move.

import "dotenv/config"
import fs from "fs"
import OpenAI from "openai"
import {OPENAI_KEY} from "./config.js"
import {anki} from "./anki.js"

const openai = new OpenAI({apiKey: OPENAI_KEY})

const DECKS = [
    "Health & Body",
    "Home & Daily life",
    "Travel & Transport",
    "Food & Cooking",
    "Clothes & Appearance",
    "Nature & Environment",
    "Work & Career",
    "IT & Technology",
    "Personality & Emotions",
    "Money & Finance",
    "Actions & Movement",
    "History & Mythology",
    "Objects & Concepts",
]

const BATCH = 30
const MOVES_FILE = "moves.json"
const apply = process.argv.includes("--apply")

const SYSTEM_PROMPT = `
You sort English vocabulary flashcards into thematic decks.

Each item has: id, word, translation (Russian), example sentence, part of speech,
and the deck it currently sits in.

Assign every item to exactly one deck from this list:
${DECKS.join("\n")}

Guidance:
- Actions & Movement — verbs of motion, posture, gesture, facial expression and
  physical manipulation (kneel, leap, shrug, stumble, clutch, yank).
  A verb goes here only when the action itself is the point; a verb about feeling
  belongs to Personality & Emotions, a verb about cooking to Food & Cooking.
- History & Mythology — weapons, armour, ancient warfare, rites, myth, royal court.
- Health & Body — body parts, illness, treatment, physical condition.
- Personality & Emotions — feelings, character traits, mental states, social attitude.
- Home & Daily life — housing, furniture, chores, everyday routine.
- Money & Finance — money, prices, paying, earning, lending, debt, tax, banking,
  inheritance, charity (salary, afford, be in debt, pay rise, lend to, purchase).
  Takes priority over Work & Career when the item is about money rather than a job.
- Objects & Concepts — abstract nouns and anything that genuinely fits nowhere else.
  Prefer a specific deck whenever one applies; this is the last resort.
- Phrases and full sentences go to the deck matching what they are about.

Keep the current deck when it is already a reasonable fit — only move a card when
another deck is clearly better. Echo the id back unchanged.
`.trim()

const SCHEMA = {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: {type: "integer"},
                    deck: {type: "string", enum: DECKS},
                },
                required: ["id", "deck"],
                additionalProperties: false,
            },
        },
    },
    required: ["items"],
    additionalProperties: false,
}

function stripHtml(s) {
    return (s || "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim()
}

async function collect() {
    const noteIds = await anki("findNotes", {query: "Word:*"})
    const notes = await anki("notesInfo", {notes: noteIds})

    // Deck lives on cards, not notes — build noteId → {deck, cardIds}.
    const cardIds = notes.flatMap(n => n.cards)
    const cards = await anki("cardsInfo", {cards: cardIds})
    const byNote = new Map()
    for (const c of cards) {
        const e = byNote.get(c.note) || {deck: c.deckName, cardIds: []}
        e.cardIds.push(c.cardId)
        byNote.set(c.note, e)
    }

    return notes.map(n => {
        const info = byNote.get(n.noteId) || {deck: "", cardIds: []}
        const pos = n.tags.find(t => t.startsWith("pos∷") || t.startsWith("pos::")) || ""
        return {
            id: n.noteId,
            word: stripHtml(n.fields.Word.value),
            translation: stripHtml(n.fields.Translation.value),
            example: stripHtml(n.fields.Example.value).slice(0, 120),
            pos: pos.replace(/^pos[∷:]+/, ""),
            currentDeck: info.deck,
            cardIds: info.cardIds,
        }
    })
}

async function classify(chunk) {
    const payload = chunk.map(r => ({
        id: r.id,
        word: r.word,
        translation: r.translation,
        example: r.example,
        pos: r.pos,
        currentDeck: r.currentDeck,
    }))
    const res = await openai.chat.completions.create({
        model: "gpt-4.1",
        messages: [
            {role: "system", content: SYSTEM_PROMPT},
            {role: "user", content: JSON.stringify(payload)},
        ],
        response_format: {
            type: "json_schema",
            json_schema: {name: "items", schema: SCHEMA, strict: true},
        },
    })
    return JSON.parse(res.choices[0].message.content).items
}

async function prepare() {
    const rows = await collect()
    console.log(`Заметок в коллекции: ${rows.length}`)

    const byId = new Map(rows.map(r => [r.id, r]))
    const moves = []

    for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH)
        process.stdout.write(`GPT ${i + 1}-${i + chunk.length} / ${rows.length}... `)
        const out = await classify(chunk)
        for (const it of out) {
            const src = byId.get(it.id)
            if (!src || it.deck === src.currentDeck) continue
            moves.push({
                id: src.id,
                word: src.word,
                translation: src.translation,
                from: src.currentDeck,
                to: it.deck,
                cardIds: src.cardIds,
            })
        }
        console.log("ok")
    }

    fs.writeFileSync(MOVES_FILE, JSON.stringify(moves, null, 2))
    console.log(`\nПредложено перемещений: ${moves.length} из ${rows.length} -> ${MOVES_FILE}`)
    return moves
}

async function applyMoves() {
    const moves = JSON.parse(fs.readFileSync(MOVES_FILE, "utf8"))
    const decks = await anki("deckNames")
    for (const d of new Set(moves.map(m => m.to))) {
        if (!decks.includes(d)) {
            await anki("createDeck", {deck: d})
            console.log(`Создана колода: ${d}`)
        }
    }

    const byTarget = new Map()
    for (const m of moves) {
        const list = byTarget.get(m.to) || []
        list.push(...m.cardIds)
        byTarget.set(m.to, list)
    }
    for (const [deck, cards] of byTarget) {
        await anki("changeDeck", {cards, deck})
        console.log(`-> ${deck}: ${cards.length} карточек`)
    }

    await anki("sync")
    console.log(`\nПеремещено заметок: ${moves.length}. AnkiWeb sync запущен`)
}

if (apply) await applyMoves()
else await prepare()
