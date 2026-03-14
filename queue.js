import { db } from "./db.js"

export function addText(text) {

    db.run(
        "INSERT INTO queue(text) VALUES(?)",
        [text]
    )
}

export function getAll() {

    return new Promise((resolve,reject)=>{

        db.all(
            "SELECT text FROM queue",
            (err,rows)=>{

                if(err) reject(err)

                resolve(rows.map(r=>r.text))
            }
        )
    })
}

export function clearQueue(){

    db.run("DELETE FROM queue")
}
