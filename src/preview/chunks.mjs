// Splits a .tex file into independently parsed chunks so a keystroke only re-parses the paragraph
// it touches (a full parse of a 2,000-line file takes ~230 ms; one paragraph takes ~1 ms).
import { parse } from '@unified-latex/unified-latex-util-parse'

// An unclosed \begin typed mid-document would otherwise merge (and re-parse) the rest of the file on
// every keystroke; past this many paragraphs the opener is rendered on its own as a visible error.
export const MAX_MERGED_PARAGRAPHS = 40

/** Parse results keyed by exact chunk text; sweep() drops entries the last update did not use. */
export class ChunkParser {
    constructor() {
        this.cache = new Map()
        this.used = new Set()
        this.parses = 0
    }

    parse(text) {
        this.used.add(text)
        let ast = this.cache.get(text)
        if (!ast) {
            ast = safeParse(text)
            this.parses++
            this.cache.set(text, ast)
        }
        return ast
    }

    sweep() {
        for (const text of this.cache.keys()) {
            if (!this.used.has(text)) this.cache.delete(text)
        }
        this.used.clear()
    }
}

function safeParse(text) {
    try {
        return parse(text)
    } catch (e) {
        // The PEG parser is tolerant, but a crash must never take the preview down mid-typing.
        return { type: 'root', content: [{ type: 'string', content: text }], parseError: e.message }
    }
}

/**
 * True when a parsed chunk leaves something open at its top level: an unmatched \begin, a "{" group,
 * an odd "$", or "\[" / "\(". The parser reports each as a plain macro/string node instead of a pair.
 */
export function opensUnclosed(ast) {
    let dollars = 0
    for (const node of ast.content) {
        if (node.type === 'macro' && (node.content === 'begin' || node.content === '[' || node.content === '(')) return true
        if (node.type === 'string' && node.content === '{') return true
        if (node.type === 'string' && /^\$+$/.test(node.content)) dollars += node.content.length
    }
    return dollars % 2 === 1
}

/** Index of the first line whose code (before an unescaped %) contains `marker`, or -1. */
export function findMarkerLine(lines, marker, from = 0) {
    for (let i = from; i < lines.length; i++) {
        if (codePart(lines[i]).includes(marker)) return i
    }
    return -1
}

function codePart(line) {
    for (let i = 0; i < line.length; i++) {
        if (line[i] !== '%') continue
        let backslashes = 0
        for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) backslashes++
        if (backslashes % 2 === 0) return line.slice(0, i)
    }
    return line
}

/**
 * Splits lines [from, to) into chunks at blank lines (a blank line ends a TeX paragraph), merging a
 * chunk with the following ones while it leaves an environment, group or math open.
 * @returns {{text: string, startLine: number, endLine: number, ast: object}[]} lines are 0-based
 */
export function splitChunks(lines, from, to, parser) {
    const paragraphs = []
    let start = -1
    for (let i = from; i <= to; i++) {
        const blank = i === to || lines[i].trim() === ''
        if (!blank && start < 0) start = i
        if (blank && start >= 0) {
            paragraphs.push([start, i - 1])
            start = -1
        }
    }
    const chunks = []
    for (let i = 0; i < paragraphs.length;) {
        let j = i
        let text = lines.slice(paragraphs[i][0], paragraphs[j][1] + 1).join('\n')
        let ast = parser.parse(text)
        while (opensUnclosed(ast) && j + 1 < paragraphs.length && j - i + 1 < MAX_MERGED_PARAGRAPHS) {
            j++
            text = lines.slice(paragraphs[i][0], paragraphs[j][1] + 1).join('\n')
            ast = parser.parse(text)
        }
        chunks.push({ text, startLine: paragraphs[i][0], endLine: paragraphs[j][1], ast })
        i = j + 1
    }
    return chunks
}
