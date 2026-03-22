import sqlite3 from "sqlite3"

export const db = new sqlite3.Database("queue.db")

db.serialize(() => {

    // очередь слов/фраз из Telegram (per-user)
    db.run(`
        CREATE TABLE IF NOT EXISTS queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL DEFAULT 0,
            text TEXT NOT NULL
        )
    `)

    // migrate existing rows: add user_id column if missing (error ignored if already exists)
    db.run(`ALTER TABLE queue ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0`, () => {})

    // replace single-column index with composite one
    db.run(`DROP INDEX IF EXISTS idx_queue_text`)
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_user_text ON queue(user_id, text)`)

    // локальный cache слов из Anki
    db.run(`
        CREATE TABLE IF NOT EXISTS anki_words (
            word TEXT PRIMARY KEY
        )
    `)

    // llm cache
    db.run(`
        CREATE TABLE IF NOT EXISTS llm_cache (
            input TEXT PRIMARY KEY,
            output TEXT
        )
    `)

    // persistent key-value settings
    db.run(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    `)
})

/*
QUEUE API
*/

export function addText(userId, text) {
    return new Promise((resolve, reject) => {
        db.run(
            "INSERT OR IGNORE INTO queue(user_id, text) VALUES(?,?)",
            [userId, text],
            err => {
                if (err) reject(err)
                else resolve()
            }
        )
    })
}

export function getAll(userId) {
    return new Promise((resolve, reject) => {
        db.all(
            "SELECT text FROM queue WHERE user_id=? ORDER BY id",
            [userId],
            (err, rows) => {
                if (err) reject(err)
                else resolve(rows.map(r => r.text))
            }
        )
    })
}

export function clearQueue(userId) {
    return new Promise((resolve, reject) => {
        db.run(
            "DELETE FROM queue WHERE user_id=?",
            [userId],
            err => {
                if (err) reject(err)
                else resolve()
            }
        )
    })
}

/*
ANKI CACHE API
*/

export function getCachedWords() {
    return new Promise((resolve, reject) => {
        db.all(
            "SELECT word FROM anki_words",
            (err, rows) => {
                if (err) reject(err)
                else resolve(new Set(rows.map(r => r.word)))
            }
        )
    })
}

export function addCachedWord(word) {
    return new Promise((resolve, reject) => {
        db.run(
            "INSERT OR IGNORE INTO anki_words(word) VALUES(?)",
            [word],
            err => {
                if (err) reject(err)
                else resolve()
            }
        )
    })
}

export function addCachedWords(words) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare(
            "INSERT OR IGNORE INTO anki_words(word) VALUES(?)"
        )
        for (const w of words) {
            stmt.run(w)
        }
        stmt.finalize(err => {
            if (err) reject(err)
            else resolve()
        })
    })
}

/*
LLM CACHE API
The cache key includes the language prefix to avoid collisions across languages.
*/

export function getLLMCache(input, language = "") {
    const key = language ? `${language}:${input}` : input
    return new Promise((resolve, reject) => {
        db.get(
            "SELECT output FROM llm_cache WHERE input=?",
            [key],
            (err, row) => {
                if (err) reject(err)
                else if (!row) resolve(null)
                else resolve(JSON.parse(row.output))
            }
        )
    })
}

export function setLLMCache(input, language = "", output) {
    const key = language ? `${language}:${input}` : input
    return new Promise((resolve, reject) => {
        db.run(
            "INSERT OR REPLACE INTO llm_cache(input,output) VALUES(?,?)",
            [key, JSON.stringify(output)],
            err => {
                if (err) reject(err)
                else resolve()
            }
        )
    })
}

/*
SETTINGS API
*/

export function getSetting(key) {
    return new Promise((resolve, reject) => {
        db.get(
            "SELECT value FROM settings WHERE key=?",
            [key],
            (err, row) => {
                if (err) reject(err)
                else resolve(row ? row.value : null)
            }
        )
    })
}

export function setSetting(key, value) {
    return new Promise((resolve, reject) => {
        db.run(
            "INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)",
            [key, value],
            err => {
                if (err) reject(err)
                else resolve()
            }
        )
    })
}

export function getUserSetting(userId, key) {
    return getSetting(`${userId}:${key}`)
}

export function setUserSetting(userId, key, value) {
    return setSetting(`${userId}:${key}`, value)
}

export async function addTokenUsage(promptTokens, completionTokens, userId = null) {
    const ops = [
        getSetting("total_prompt_tokens"),
        getSetting("total_completion_tokens"),
    ]
    if (userId !== null) {
        ops.push(getUserSetting(userId, "prompt_tokens"))
        ops.push(getUserSetting(userId, "completion_tokens"))
    }
    const vals = await Promise.all(ops)
    const saves = [
        setSetting("total_prompt_tokens", String((Number(vals[0]) || 0) + promptTokens)),
        setSetting("total_completion_tokens", String((Number(vals[1]) || 0) + completionTokens)),
    ]
    if (userId !== null) {
        saves.push(setUserSetting(userId, "prompt_tokens", String((Number(vals[2]) || 0) + promptTokens)))
        saves.push(setUserSetting(userId, "completion_tokens", String((Number(vals[3]) || 0) + completionTokens)))
    }
    await Promise.all(saves)
}

export async function getTokenUsage() {
    const [p, c] = await Promise.all([
        getSetting("total_prompt_tokens"),
        getSetting("total_completion_tokens"),
    ])
    return {
        promptTokens: Number(p) || 0,
        completionTokens: Number(c) || 0,
    }
}

export async function getUserTokenUsage(userId) {
    const [p, c] = await Promise.all([
        getUserSetting(userId, "prompt_tokens"),
        getUserSetting(userId, "completion_tokens"),
    ])
    return {
        promptTokens: Number(p) || 0,
        completionTokens: Number(c) || 0,
    }
}

export async function addGoogleTranslateWords(userId, count) {
    const current = await getUserSetting(userId, "google_words")
    await setUserSetting(userId, "google_words", String((Number(current) || 0) + count))
}

export async function getGoogleTranslateWords(userId) {
    const val = await getUserSetting(userId, "google_words")
    return Number(val) || 0
}

// Returns unique user IDs that have any recorded usage stats
export async function getAllUsersWithStats() {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT DISTINCT substr(key, 1, instr(key, ':') - 1) as uid
             FROM settings
             WHERE (key LIKE '%:prompt_tokens' OR key LIKE '%:google_words')
               AND CAST(substr(key, 1, instr(key, ':') - 1) AS INTEGER) > 0`,
            (err, rows) => {
                if (err) reject(err)
                else resolve(rows.map(r => Number(r.uid)))
            }
        )
    })
}

export function clearAnkiCache() {
    return new Promise((resolve, reject) => {
        db.run(
            "DELETE FROM anki_words",
            err => {
                if (err) reject(err)
                else resolve()
            }
        )
    })
}