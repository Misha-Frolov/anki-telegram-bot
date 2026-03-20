import fetch from "node-fetch"
import { anki } from "./anki.js"

export async function downloadAudio(word){

    const url =
        "https://translate.google.com/translate_tts?ie=UTF-8&q=" +
        encodeURIComponent(word) +
        "&tl=en&client=tw-ob"

    const res = await fetch(url)

    if(!res.ok){
        throw new Error("TTS failed")
    }

    const buf = Buffer.from(
        await res.arrayBuffer()
    )

    const slug = word.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)
    const filename = `tts-${slug}-${Date.now()}.mp3`

    await anki("storeMediaFile",{
        filename,
        data:buf.toString("base64")
    })

    return `[sound:${filename}]`
}
