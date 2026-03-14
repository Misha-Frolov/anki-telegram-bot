import sqlite3 from "sqlite3"

export const db = new sqlite3.Database("queue.db")

db.serialize(() => {

    db.run(`
    CREATE TABLE IF NOT EXISTS queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT
    )
  `, err => {

        if (err) {
            console.error("DB init error:", err)
        }

    })

})
