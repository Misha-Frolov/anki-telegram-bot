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

const SYSTEM_PROMPT = `
Generate Anki card JSON for English vocabulary.

Keep phrases intact. Do not split phrases into words.

Deck must be one of:
${[...DECKS].join("\n")}

Tags:
level∷A1/A2/B1/B2/C1
pos∷noun/verb/adjective/adverb/phrase/phrasal_verb
`

export async function generateCards(rawText) {
    const res = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        temperature: 0,
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "anki_cards",
                schema: {
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
            }
        },
        messages: [
            {role: "system", content: SYSTEM_PROMPT},
            {role: "user", content: rawText}
        ]
    })

    const text = res.choices[0].message.content

    let json

    try {
        json = JSON.parse(text)
    } catch {
        throw new Error("INVALID_JSON_FROM_LLM")
    }

    const invalid = json.find(c => !DECKS.has(c.deck))
    if (invalid) {
        throw new Error(`INVALID_DECK_FROM_LLM: ${invalid.deck}`)
    }

    return json
}
