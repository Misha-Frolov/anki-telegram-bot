import fetch from "node-fetch"

export async function translateWords(words, language) {
    return Promise.all(words.map(w => translateWord(w)))
}

async function translateWord(word) {
    const url =
        "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ru&dt=t&q=" +
        encodeURIComponent(word)

    const res = await fetch(url)
    if (!res.ok) throw new Error(`Google Translate failed for: ${word}`)

    const data = await res.json()
    const translation = data[0]?.map(t => t[0]).filter(Boolean).join("") || word

    return { word, translation, example: "" }
}