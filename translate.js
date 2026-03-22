import fetch from "node-fetch"

export async function translateWords(words, language) {
    const valid = words.filter(w => /\p{L}/u.test(w))
    const checked = await Promise.all(valid.map(w => isValidWord(w, language)))
    const results = await Promise.all(
        valid
            .filter((_, i) => checked[i])
            .map(w => translateWord(w))
    )
    return results.filter(r => r !== null)
}

// Skip dictionary check for phrases (spaces) — APIs don't handle them well
async function isValidWord(word, language) {
    if (word.includes(" ")) return true
    try {
        if (language === "English") {
            const res = await fetch(
                `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
                {signal: AbortSignal.timeout(3000)}
            )
            return res.ok
        } else {
            const res = await fetch(
                `https://en.wiktionary.org/api/rest_v1/page/summary/${encodeURIComponent(word)}`,
                {signal: AbortSignal.timeout(3000)}
            )
            return res.ok
        }
    } catch {
        return true // on timeout or error — don't block the word
    }
}

async function translateWord(word) {
    const url =
        "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ru&dt=t&q=" +
        encodeURIComponent(word)

    const res = await fetch(url)
    if (!res.ok) throw new Error(`Google Translate failed for: ${word}`)

    const data = await res.json()
    const translation = data[0]?.map(t => t[0]).filter(Boolean).join("") || word

    if (translation.toLowerCase() === word.toLowerCase()) return null

    return { word, translation, example: "" }
}