// One-off importer for wordsfromtext.com exports ("Memrise с 1 предложением" format).
//
//   node import-book.mjs "path/to/book_memrise1.txt" --tag book∷song_of_achilles
//   node import-book.mjs "path/to/book_memrise1.txt" --tag book∷song_of_achilles --import
//
// Without --import it only prepares cards.json and prints a preview.

import "dotenv/config"
import fs from "fs"
import OpenAI from "openai"
import {OPENAI_KEY, MODEL} from "./config.js"
import {anki} from "./anki.js"
import {downloadAudio} from "./tts.js"

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

const FALLBACK_DECK = "Objects & Concepts"
const BATCH = 25
const CARDS_FILE = "cards.json"

const args = process.argv.slice(2)
const file = args.find(a => !a.startsWith("--"))
const bookTag = args[args.indexOf("--tag") + 1]
const doImport = args.includes("--import")

if (!file || !bookTag || bookTag.startsWith("--")) {
    console.error("usage: node import-book.mjs <file.txt> --tag book∷slug [--import]")
    process.exit(1)
}

function normalize(word) {
    return word.toLowerCase().replace(/[–—-]/g, " ").replace(/\s+/g, " ").trim()
}

// wordsfromtext lists verbs as "to stare"; the collection stores them bare.
function stripTo(word) {
    return word.replace(/^to\s+/i, "").trim()
}

function parseFile(path) {
    return fs.readFileSync(path, "utf8")
        .split(/\r?\n/)
        .filter(l => l.trim())
        .map(line => {
            const [word, translation, example, ipa, pos] = line.split("\t")
            return {
                word: stripTo(word || ""),
                dictTranslation: (translation || "").trim(),
                example: (example || "").trim(),
                ipa: (ipa || "").trim(),
                pos: (pos || "").trim(),
            }
        })
        .filter(r => r.word)
}

async function existingWords() {
    const ids = await anki("findNotes", {query: "Word:*"})
    if (!ids.length) return new Set()
    const notes = await anki("notesInfo", {notes: ids})
    const set = new Set()
    for (const n of notes) {
        const w = normalize(n.fields.Word.value.replace(/<[^>]+>/g, ""))
        if (w) {
            set.add(w)
            set.add(stripTo(w))
        }
    }
    return set
}

const SYSTEM_PROMPT = `
You refine Russian translations for English vocabulary extracted from a novel.

For every input item you get:
- word: the English headword (verbs are given without "to")
- dictionary: a context-free dictionary translation, often listing several unrelated senses
- example: the actual sentence the word appears in, taken from the book
- pos: part of speech

Echo the id back unchanged on every card.

Note that the same word may appear twice, once as a noun and once as a verb
(tear/to tear, bow/to bow). Treat those as separate items and judge each one
by its own example sentence.

Your job:
1. translation — 1 to 3 Russian equivalents, comma-separated, ordered by fit.
   The FIRST one MUST be the sense the word carries in the example sentence.
   Use the dictionary translation as your starting point: keep the senses that fit,
   drop the ones that do not, and fix it when none of them match the example.
   Do not translate the example sentence itself. No explanations, no Latin script.
2. deck — exactly one of the decks listed below.
3. level — CEFR level of the word: A1, A2, B1, B2 or C1.

Decks:
${DECKS.join("\n")}

Deck guidance:
- Actions & Movement — verbs of motion, posture, gesture and facial expression
  (kneel, leap, shrug, frown, stumble, clutch).
- History & Mythology — weapons, armour, ancient warfare, rites, myth and court life
  (spear, chariot, pyre, oath, herald, centaur).
- Health & Body — body parts and physical condition.
- Personality & Emotions — feelings, character traits, emotional states.
Use ${FALLBACK_DECK} only when nothing else fits.
`.trim()

const SCHEMA = {
    type: "object",
    properties: {
        cards: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    // echo of the input id — the list can contain the same word twice
                    // (noun + verb of one lemma), so mapping back by word is not safe
                    id: {type: "integer"},
                    word: {type: "string"},
                    translation: {type: "string"},
                    deck: {type: "string", enum: DECKS},
                    level: {type: "string", enum: ["A1", "A2", "B1", "B2", "C1"]},
                },
                required: ["id", "word", "translation", "deck", "level"],
                additionalProperties: false,
            },
        },
    },
    required: ["cards"],
    additionalProperties: false,
}

async function refine(rows) {
    const payload = rows.map(r => ({
        id: r.id,
        word: r.word,
        dictionary: r.dictTranslation,
        example: r.example,
        pos: r.pos,
    }))
    const res = await openai.chat.completions.create({
        model: "gpt-4.1",   // stronger than the bot's gpt-4.1-mini: the whole point here is sense disambiguation
        messages: [
            {role: "system", content: SYSTEM_PROMPT},
            {role: "user", content: JSON.stringify(payload)},
        ],
        response_format: {
            type: "json_schema",
            json_schema: {name: "cards", schema: SCHEMA, strict: true},
        },
    })
    return JSON.parse(res.choices[0].message.content).cards
}

function posTag(pos) {
    const p = pos.toLowerCase()
    if (p.startsWith("adj")) return "adjective"
    if (p.startsWith("adv")) return "adverb"
    if (p.startsWith("p. v") || p.startsWith("phr")) return "phrasal_verb"
    if (p.startsWith("verb")) return "verb"
    if (p.startsWith("noun")) return "noun"
    return null
}

async function prepare() {
    const rows = parseFile(file)
    const have = await existingWords()

    const skipped = []
    const fresh = []
    for (const r of rows) {
        if (have.has(normalize(r.word))) skipped.push(r.word)
        else fresh.push(r)
    }

    console.log(`В файле: ${rows.length} | уже в Anki: ${skipped.length} | к импорту: ${fresh.length}`)
    if (skipped.length) console.log(`Пропущены: ${skipped.join(", ")}\n`)

    fresh.forEach((r, i) => { r.id = i })
    const byId = new Map(fresh.map(r => [r.id, r]))
    const cards = []

    for (let i = 0; i < fresh.length; i += BATCH) {
        const chunk = fresh.slice(i, i + BATCH)
        process.stdout.write(`GPT ${i + 1}-${i + chunk.length} / ${fresh.length}... `)
        const out = await refine(chunk)
        for (const c of out) {
            const src = byId.get(c.id)
            if (!src) {
                console.log(`  [!] неизвестный id ${c.id} (${c.word})`)
                continue
            }
            const tags = [`level∷${c.level}`, bookTag]
            const pt = posTag(src.pos)
            if (pt) tags.push(`pos∷${pt}`)
            cards.push({
                word: src.word,
                translation: c.translation,
                example: src.example,
                deck: DECKS.includes(c.deck) ? c.deck : FALLBACK_DECK,
                tags,
                dictTranslation: src.dictTranslation,
            })
        }
        console.log("ok")
    }

    const merged = mergeHomonyms(cards)
    fs.writeFileSync(CARDS_FILE, JSON.stringify(merged, null, 2))
    console.log(`\nГотово: ${merged.length} карточек -> ${CARDS_FILE}`)
    return merged
}

// "tear" the noun and "to tear" the verb both become "tear" once the particle is
// stripped, and Anki dedupes on the first field — so they have to share one note.
function mergeHomonyms(cards) {
    const out = []
    const seen = new Map()
    for (const c of cards) {
        const key = c.word.toLowerCase()
        const prev = seen.get(key)
        if (!prev) {
            seen.set(key, c)
            out.push(c)
            continue
        }
        console.log(`Склеены омонимы: ${c.word} — "${prev.translation}" + "${c.translation}"`)
        prev.translation = `${prev.translation}; ${c.translation}`
        prev.example = [prev.example, c.example].filter(Boolean).join("<br>")
        prev.dictTranslation = `${prev.dictTranslation}; ${c.dictTranslation}`
        for (const t of c.tags) {
            if (!prev.tags.includes(t)) prev.tags.push(t)
        }
    }
    return out
}

// Words from the book that were already in the collection: tag them too, and fill
// the Example field when it is empty — a real sentence beats no sentence.
async function updateExisting() {
    const rows = parseFile(file)
    const ids = await anki("findNotes", {query: "Word:*"})
    const notes = await anki("notesInfo", {notes: ids})

    const byWord = new Map()
    for (const n of notes) {
        byWord.set(normalize(n.fields.Word.value.replace(/<[^>]+>/g, "")), n)
    }

    const tagged = []
    const filled = []
    for (const r of rows) {
        const n = byWord.get(normalize(r.word))
        if (!n) continue
        if (!n.tags.includes(bookTag)) {
            await anki("addTags", {notes: [n.noteId], tags: bookTag})
            tagged.push(r.word)
        }
        if (!n.fields.Example.value.trim() && r.example) {
            await anki("updateNoteFields", {
                note: {id: n.noteId, fields: {Example: r.example}},
            })
            filled.push(r.word)
        }
    }
    console.log(`Тег проставлен старым заметкам: ${tagged.length} (${tagged.join(", ")})`)
    console.log(`Примеры дописаны: ${filled.length}${filled.length ? ` (${filled.join(", ")})` : ""}\n`)
}

async function push() {
    const cards = JSON.parse(fs.readFileSync(CARDS_FILE, "utf8"))
    const decks = await anki("deckNames")
    for (const d of new Set(cards.map(c => c.deck))) {
        if (!decks.includes(d)) {
            await anki("createDeck", {deck: d})
            console.log(`Создана колода: ${d}`)
        }
    }

    const notes = []
    for (const [i, c] of cards.entries()) {
        let audio = ""
        try {
            audio = await downloadAudio(c.word)
        } catch {
            console.log(`  без озвучки: ${c.word}`)
        }
        notes.push({
            deckName: c.deck,
            modelName: MODEL,
            fields: {
                Word: c.word,
                Translation: c.translation,
                Example: c.example,
                Pronunciation: audio,
            },
            tags: c.tags,
        })
        if ((i + 1) % 25 === 0) console.log(`  озвучено ${i + 1}/${cards.length}`)
    }

    const res = await anki("addNotes", {notes})
    const added = res.filter(Boolean).length
    const rejected = res.map((id, i) => id ? null : cards[i].word).filter(Boolean)
    console.log(`\nДобавлено: ${added} из ${cards.length}`)
    if (rejected.length) console.log(`Отклонено Anki (дубли): ${rejected.join(", ")}`)

    await anki("sync")
    console.log("AnkiWeb sync запущен")
}

if (doImport) {
    await updateExisting()
    await push()
} else {
    await prepare()
}
