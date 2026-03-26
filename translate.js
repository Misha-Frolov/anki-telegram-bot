import fetch from "node-fetch"

export async function translateWords(words, language) {
    const valid = words.filter(w => /\p{L}/u.test(w))
    const checked = await Promise.all(valid.map(w => isValidWord(w, language)))
    const langCode = WIKTIONARY_CODE[language] ?? "auto"
    const results = await Promise.all(
        valid
            .filter((_, i) => checked[i])
            .map(w => translateWord(w, langCode))
    )
    return results.filter(r => r !== null)
}

// Maps language names to Wiktionary subdomain codes.
// Languages not listed here skip validation (return true).
const WIKTIONARY_CODE = {
    Afrikaans: "af", Albanian: "sq", Amharic: "am", Arabic: "ar",
    Armenian: "hy", Azerbaijani: "az", Basque: "eu", Belarusian: "be",
    Bengali: "bn", Bosnian: "bs", Bulgarian: "bg", Catalan: "ca",
    Chinese: "zh", Croatian: "hr", Czech: "cs", Danish: "da",
    Dutch: "nl", English: "en", Esperanto: "eo", Estonian: "et",
    Finnish: "fi", French: "fr", Galician: "gl", Georgian: "ka",
    German: "de", Greek: "el", Gujarati: "gu", Hebrew: "he",
    Hindi: "hi", Hungarian: "hu", Icelandic: "is", Indonesian: "id",
    Irish: "ga", Italian: "it", Japanese: "ja", Kannada: "kn",
    Kazakh: "kk", Korean: "ko", Kurdish: "ku", Latin: "la",
    Latvian: "lv", Lithuanian: "lt", Macedonian: "mk", Malay: "ms",
    Malayalam: "ml", Maltese: "mt", Marathi: "mr", Mongolian: "mn",
    Nepali: "ne", Norwegian: "no", Persian: "fa", Polish: "pl",
    Portuguese: "pt", Punjabi: "pa", Romanian: "ro", Serbian: "sr",
    Sinhala: "si", Slovak: "sk", Slovenian: "sl", Spanish: "es",
    Swahili: "sw", Swedish: "sv", Tajik: "tg", Tamil: "ta",
    Telugu: "te", Thai: "th", Turkish: "tr", Ukrainian: "uk",
    Urdu: "ur", Uzbek: "uz", Vietnamese: "vi", Welsh: "cy",
}

// Phrases (with spaces) skip validation — dictionary APIs don't handle them well.
// For English: use Free Dictionary API. For other languages: use native Wiktionary.
// Languages without a Wiktionary mapping skip validation entirely.
async function isValidWord(word, language) {
    if (word.includes(" ")) return true
    const code = WIKTIONARY_CODE[language]
    if (!code) return true
    try {
        if (language === "English") {
            const res = await fetch(
                `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
                {signal: AbortSignal.timeout(3000)}
            )
            return res.ok
        } else {
            const res = await fetch(
                `https://${code}.wiktionary.org/w/api.php?action=query&titles=${encodeURIComponent(word)}&format=json&redirects=1`,
                {signal: AbortSignal.timeout(3000)}
            )
            const data = await res.json()
            return !("missing" in Object.values(data["query"]["pages"])[0])
        }
    } catch {
        return true // on timeout or network error — don't block the word
    }
}

async function translateWord(word, langCode = "auto") {
    const url =
        "https://translate.googleapis.com/translate_a/single?client=gtx&sl=" + langCode + "&tl=ru&dt=t&q=" +
        encodeURIComponent(word)

    const res = await fetch(url)
    if (!res.ok) throw new Error(`Google Translate failed for: ${word}`)

    const data = await res.json()
    const translation = data[0]?.map(t => t[0]).filter(Boolean).join("") || word

    if (translation.toLowerCase() === word.toLowerCase()) return null

    return { word, translation, example: "" }
}