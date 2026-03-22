import OpenAI from "openai"
import {OPENAI_KEY} from "./config.js"

const openai = new OpenAI({apiKey: OPENAI_KEY})

const DECKS = new Set([
    "Health & Body",
    "Home & Daily Life",
    "Travel & Transport",
    "Food & Cooking",
    "Clothes & Appearance",
    "Nature & Environment",
    "Work & Career",
    "Personality & Emotions",
    "Objects & Concepts",
])

// Full Anki prompt (English / admin mode)
const SYSTEM_PROMPT_ANKI = `
Generate Anki card JSON for English vocabulary.
Translation must be in Russian. Do not explain the word in English.

Keep phrases intact. Do not split phrases into words.

Deck must be one of:
${[...DECKS].join("\n")}

Tags:
level∷A1/A2/B1/B2/C1
pos∷noun/verb/adjective/adverb/phrase/phrasal_verb
`

// Simplified prompt for any other language
function buildSimplePrompt(language) {
    return `
Generate flashcard JSON for ${language} vocabulary.
Translation must be in Russian. Do not explain the word in ${language}.

Keep phrases intact. Do not split phrases into words.
`
}

const SCHEMA_ANKI = {
    type: "object",
    properties: {
        cards: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    word: {type: "string"},
                    translation: {type: "string"},
                    example: {type: "string"},
                    deck: {type: "string"},
                    tags: {
                        type: "array",
                        items: {type: "string"},
                        minItems: 2,
                        maxItems: 2
                    }
                },
                required: ["word", "translation", "example", "deck", "tags"]
            }
        }
    },
    required: ["cards"]
}

const SCHEMA_SIMPLE = {
    type: "object",
    properties: {
        cards: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    word: {type: "string"},
                    translation: {type: "string"},
                    example: {type: "string"},
                },
                required: ["word", "translation", "example"]
            }
        }
    },
    required: ["cards"]
}

export async function generateCards(rawText, language = "English") {
    const isAnkiMode = language === "English"
    const systemPrompt = isAnkiMode ? SYSTEM_PROMPT_ANKI : buildSimplePrompt(language)
    const schema = isAnkiMode ? SCHEMA_ANKI : SCHEMA_SIMPLE

    const res = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        temperature: 0,
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "flashcards",
                schema
            }
        },
        messages: [
            {role: "system", content: systemPrompt},
            {role: "user", content: rawText}
        ]
    })

    const text = res.choices[0].message.content

    let json

    try {
        json = JSON.parse(text).cards
    } catch {
        throw new Error("INVALID_JSON_FROM_LLM")
    }

    if (isAnkiMode) {
        const invalid = json.find(c => !DECKS.has(c.deck))
        if (invalid) {
            throw new Error(`INVALID_DECK_FROM_LLM: ${invalid.deck}`)
        }
    }

    return {cards: json, usage: res.usage}
}