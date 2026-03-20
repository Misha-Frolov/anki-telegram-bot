import fetch from "node-fetch"
import { ANKI_URL } from "./config.js"

export async function anki(action, params = {}, retries = 3) {
    try {
        const res = await fetch(ANKI_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                action,
                version: 6,
                params
            })
        })
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`)
        }
        const json = await res.json()
        if (json.error) {
            throw new Error(json.error)
        }
        return json.result
    } catch (err) {
        if (retries <= 0) {
            throw err
        }
        console.log(`Retry Anki API (${retries})`)
        await new Promise(r => setTimeout(r, 300))
        return anki(action, params, retries - 1)
    }
}
