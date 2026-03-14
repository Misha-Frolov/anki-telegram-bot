import OpenAI from "openai"
import { OPENAI_KEY } from "./config.js"

const openai = new OpenAI({apiKey:OPENAI_KEY})

export async function generateCards(text){

    const prompt = `
You generate structured data for Anki cards.

INPUT
Arbitrary English text that may contain:

- single words
- phrases
- sentences
- commas or separators

TASK

Extract vocabulary items.

Rules:

- keep phrases intact
- do not split phrases into words
- normalize whitespace
- remove surrounding punctuation
- preserve order of appearance
- return each item only once
- normalize single words to lowercase

OUTPUT

Return ONLY a valid JSON array.

Do not include explanations.
Do not include markdown.
Do not include code blocks.
Output must be valid JSON.parse().

SCHEMA

Each element must follow exactly this schema:

{
"word": string,
"translation": string,
"example": string,
"deck": string,
"tags": [string,string]
}

FIELD RULES

word
English word or phrase exactly as extracted from the input.

translation
Russian translation suitable for everyday usage.

example
One natural English sentence using the word or phrase.

deck
Must be EXACTLY one of the following values:

Health & Body
Home & Daily Life
Travel & Transport
Food & Cooking
Clothes & Appearance
Nature & Environment
Work & Career
Personality & Emotions
Objects & Concepts

tags

Array with exactly two elements.

First element must be one of:

level∷A1
level∷A2
level∷B1
level∷B2
level∷C1

Second element must be one of:

pos∷noun
pos∷verb
pos∷adjective
pos∷adverb
pos∷phrase
pos∷phrasal_verb

Text:

${text}
`

    const res = await openai.chat.completions.create({
        model:"gpt-4.1-mini",
        temperature: 0,
        messages:[
            {role:"user",content:prompt}
        ]
    })

    const content = res.choices[0].message.content
        .replace(/```json/g,"")
        .replace(/```/g,"")

    return JSON.parse(content)
}
