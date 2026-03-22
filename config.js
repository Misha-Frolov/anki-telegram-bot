export const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN
export const OPENAI_KEY = process.env.OPENAI_API_KEY
export const ADMIN_ID = Number(process.env.TELEGRAM_ADMIN_ID)

export const TEACHER_IDS = (process.env.TEACHER_IDS || "")
    .split(",")
    .map(s => Number(s.trim()))
    .filter(Boolean)

// "gpt" (default) — GPT with examples for all users
// "google" — Google Translate (free, no examples) for non-admin users
export const TRANSLATE_ENGINE = process.env.TRANSLATE_ENGINE || "gpt"

export const ANKI_URL = process.env.ANKI_URL || "http://localhost:8765"

export const MODEL = "Basic (and reversed card)"

if (!TELEGRAM_TOKEN) {
    throw new Error("TELEGRAM_TOKEN is not set")
}

if (!OPENAI_KEY) {
    throw new Error("OPENAI_API_KEY is not set")
}

if (!ADMIN_ID) {
    throw new Error("TELEGRAM_ADMIN_ID is not set or not a valid number")
}
