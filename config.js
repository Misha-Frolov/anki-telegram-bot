export const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN
export const OPENAI_KEY = process.env.OPENAI_API_KEY
export const ADMIN_ID = Number(process.env.TELEGRAM_ADMIN_ID)

export const ANKI_URL = "http://localhost:8765"

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
