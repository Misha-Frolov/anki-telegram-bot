import fetch from "node-fetch"
import { ANKI_URL } from "./config.js"

export async function anki(action, params={}){

    const res = await fetch(ANKI_URL,{
        method:"POST",
        body:JSON.stringify({
            action,
            version:6,
            params
        })
    })

    const json = await res.json()
    if(json.error) throw new Error(json.error)
    return json.result
}

export async function getExistingWords(){

    const ids = await anki("findNotes",{query:"Word:*"})
    if(!ids.length) return new Set()
    const notes = await anki("notesInfo",{notes:ids})
    const set = new Set()

    for(const n of notes){
        set.add(
            n.fields.Word.value
                .trim()
                .toLowerCase()
        )
    }

    return set
}
