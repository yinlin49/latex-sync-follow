// Page layout (paper, margins, font size) and class-specific output, so the preview is laid out like
// the PDF page instead of as a generic web page.
import { htmlLike } from '@unified-latex/unified-latex-util-html-like'
import { printRaw } from '@unified-latex/unified-latex-util-print-raw'

// sizes in PostScript points (bp), like the PDF
const PAPER = { letterpaper: [612, 792], a4paper: [595.3, 841.9], a5paper: [419.5, 595.3], b5paper: [498.9, 708.7],
    legalpaper: [612, 1008], executivepaper: [522, 756] }
const UNIT_BP = { bp: 1, pt: 72 / 72.27, in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pc: 12 * 72 / 72.27 }
// article's \textwidth for 10/11/12pt (TeX points); LaTeX centres the text block on the page
const TEXT_WIDTH_PT = { 10: 345, 11: 360, 12: 390 }

/** The {argument} of a macro the parser may not know: attached args, else the next group node. */
function argumentOf(nodes, i) {
    const node = nodes[i]
    const attached = node.args?.filter(a => a.openMark === '{').at(-1)
    if (attached) return attached.content
    for (let j = i + 1; j < nodes.length; j++) {
        if (nodes[j].type === 'whitespace' || nodes[j].type === 'comment') continue
        return nodes[j].type === 'group' ? nodes[j].content : null
    }
    return null
}

/** [options] of a macro: attached, or the "[" ... "]" strings the parser leaves for unknown macros. */
function optionsOf(nodes, i) {
    const attached = nodes[i].args?.find(a => a.openMark === '[')
    if (attached) return printRaw(attached.content)
    let j = i + 1
    while (nodes[j]?.type === 'whitespace') j++
    if (nodes[j]?.type !== 'string' || nodes[j].content !== '[') return ''
    const parts = []
    for (j++; j < nodes.length && !(nodes[j].type === 'string' && nodes[j].content === ']'); j++) parts.push(printRaw(nodes[j]))
    return parts.join('')
}

function lengthBp(text) {
    const m = /^\s*(-?[\d.]+)\s*(bp|pt|in|cm|mm|pc)\s*$/.exec(text)
    return m ? parseFloat(m[1]) * UNIT_BP[m[2]] : null
}

/** Document class, its options and geometry settings, from the preamble (and local .cls files). */
export function documentSetup(preambleNodeLists) {
    const setup = { className: '', options: [], geometry: [] }
    for (const nodes of preambleNodeLists) {
        nodes.forEach((node, i) => {
            if (node.type !== 'macro') return
            if (node.content === 'documentclass') {
                setup.className = printRaw(argumentOf(nodes, i) ?? []).trim()
                setup.options.push(...optionsOf(nodes, i).split(','))
            } else if (node.content === 'LoadClass') {
                setup.options.push(...optionsOf(nodes, i).split(','))
            } else if (node.content === 'usepackage' && printRaw(argumentOf(nodes, i) ?? []).trim() === 'geometry') {
                setup.geometry.push(...optionsOf(nodes, i).split(','))
            } else if (node.content === 'geometry') {
                setup.geometry.push(...printRaw(argumentOf(nodes, i) ?? []).split(','))
            }
        })
    }
    setup.options = setup.options.map(s => s.trim()).filter(Boolean)
    return setup
}

/** Page box in bp: { width, left, right, top, fontPt }. */
export function pageLayout(setup) {
    const fontPt = setup.options.includes('12pt') ? 12 : setup.options.includes('11pt') ? 11 : 10
    const [width] = PAPER[setup.options.find(o => o in PAPER)] ?? PAPER.letterpaper
    const side = (width - TEXT_WIDTH_PT[fontPt] * UNIT_BP.pt) / 2
    const page = { width, left: side, right: side, top: 72 + 30, fontPt }
    for (const option of setup.geometry) {
        const [key, value] = option.split('=').map(s => s?.trim())
        const length = value === undefined ? null : lengthBp(value)
        if (length === null) continue
        if (key === 'margin' || key === 'hmargin') page.left = page.right = length
        if (key === 'margin' || key === 'vmargin') page.top = length
        if (key === 'left' || key === 'lmargin' || key === 'inner') page.left = length
        if (key === 'right' || key === 'rmargin' || key === 'outer') page.right = length
        if (key === 'top' || key === 'tmargin') page.top = length
    }
    return page
}

const el = (tag, attributes, content = []) => htmlLike({ tag, attributes, content })

/**
 * resume.cls ("Medium Length Professional CV") prints \name and up to three \address lines from its own
 * \begin{document}: the 1st \address call is printed second, the 2nd third and the 3rd first.
 * @returns header nodes, or null when the class prints nothing of its own
 */
export function classHeader(setup, preambleNodeLists) {
    if (setup.className !== 'resume') return null
    let name = null
    const addresses = []
    for (const nodes of preambleNodeLists) {
        nodes.forEach((node, i) => {
            if (node.type !== 'macro') return
            if (node.content === 'name') name = argumentOf(nodes, i)
            if (node.content === 'address') addresses.push(argumentOf(nodes, i))
        })
    }
    if (!name && addresses.length === 0) return null
    const [two, three, one] = addresses
    const separator = () => [{ type: 'string', content: ' ' }, { type: 'inlinemath', content: [{ type: 'macro', content: 'diamond' }] },
        { type: 'string', content: ' ' }]
    // inside \printaddress, \\ prints the separator instead of breaking the line
    const line = nodes => nodes.flatMap(n => n.type === 'macro' && n.content === '\\' ? separator() : [n])
    return [el('div', { class: 'lp-resume-header' }, [
        el('div', { class: 'lp-resume-name' }, structuredClone(name ?? [])),
        ...[one, two, three].filter(Boolean).map(a => el('div', { class: 'lp-resume-address' }, line(structuredClone(a)))),
    ])]
}
