import sqlite3 from "sqlite3"

export const db = new sqlite3.Database("queue.db")

db.serialize(() => {

    // очередь слов/фраз из Telegram
    db.run(`
        CREATE TABLE IF NOT EXISTS queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            text TEXT NOT NULL
        )
    `)

    db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_text
        ON queue(text)
    `)

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

export function addText(text) {
    return new Promise((resolve, reject) => {
        db.run(
            "INSERT OR IGNORE INTO queue(text) VALUES(?)",
            [text],
            err => {
                if (err) reject(err)
                else resolve()
            }
        )
    })
}

export function getAll() {
    return new Promise((resolve, reject) => {
        db.all(
            "SELECT text FROM queue ORDER BY id",
            (err, rows) => {
                if (err) reject(err)
                else resolve(rows.map(r => r.text))
            }
        )
    })
}

export function clearQueue() {
    return new Promise((resolve, reject) => {
        db.run(
            "DELETE FROM queue",
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
                resolve(new Set(rows.map(r => r.word)))
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

export function getLLMCache(input) {
    return new Promise((resolve,reject)=>{
        db.get(
            "SELECT output FROM llm_cache WHERE input=?",
            [input],
            (err,row)=>{
                if(err) reject(err)
                if(!row) {
                    resolve(null)
                    return
                }
                resolve(JSON.parse(row.output))
            }
        )
    })
}

export function setLLMCache(input,output){
    return new Promise((resolve,reject)=>{
        db.run(
            "INSERT OR REPLACE INTO llm_cache(input,output) VALUES(?,?)",
            [input,JSON.stringify(output)],
            err => {
                if(err) {
                    reject(err)
                    return
                }
                resolve()
            }
        )
    })
}

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
