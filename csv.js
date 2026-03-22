export function generateCSV(cards) {
    const header = "#separator:tab\n#html:false"
    const rows = cards.map(c =>
        [c.word, c.translation, c.example || ""]
            .map(s => s.replace(/\t/g, " ").replace(/\n/g, " "))
            .join("\t")
    )
    return [header, ...rows].join("\n")
}

export function generateText(cards) {
    return cards
        .map(c => `${c.word} — ${c.translation}${c.example ? "\n" + c.example + "\n" : ""}`)
        .join("\n")
}
