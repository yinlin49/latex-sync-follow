// Minimal BibTeX reader for the preview's reference list: @type{key, field = {..} | ".." | word, ...}.
// shortcut: no @string macros or "#" concatenation; upgrade to a full parser if bibliographies need them.

/** @returns {{[key: string]: {[field: string]: string}}} field values with braces stripped */
export function parseBib(text) {
    const entries = Object.create(null) // keys are user text, e.g. @misc{__proto__, ...}
    let i = 0
    const skipSpace = () => {
        while (i < text.length && /\s/.test(text[i])) i++
    }
    const readUntil = stops => {
        const start = i
        while (i < text.length && !stops.includes(text[i])) i++
        return text.slice(start, i).trim()
    }
    const readValue = () => {
        skipSpace()
        if (text[i] === '{' || text[i] === '"') {
            const close = text[i] === '{' ? '}' : '"'
            let depth = 0
            const start = ++i
            for (; i < text.length; i++) {
                if (text[i] === '\\') {
                    i++
                    continue
                }
                if (text[i] === '{') depth++
                else if (text[i] === '}' && depth > 0) depth--
                else if (text[i] === close && depth === 0) break
            }
            return text.slice(start, i++)
        }
        return readUntil([',', '}'])
    }
    while ((i = text.indexOf('@', i)) >= 0) {
        i++
        const type = readUntil(['{', '(']).toLowerCase()
        if (!type || i >= text.length) break
        i++
        if (type === 'comment' || type === 'preamble' || type === 'string') continue
        const key = readUntil([',', '}'])
        const fields = {}
        while (i < text.length && text[i] === ',') {
            i++
            skipSpace()
            if (text[i] === '}') break
            const name = readUntil(['=', '}', ',']).toLowerCase()
            if (text[i] !== '=') break
            i++
            fields[name] = readValue().replace(/[{}]/g, '').replace(/\s+/g, ' ').trim()
            skipSpace()
        }
        if (key) entries[key] = fields
    }
    return entries
}
