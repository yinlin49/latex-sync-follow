// LaTeX counters, labels, references and citations. One document-order walk is shared by the global
// analysis pass and by block rendering, so a number is computed the same way in both.
import { printRaw } from '@unified-latex/unified-latex-util-print-raw'

const SECTION_LEVEL = { chapter: 0, section: 1, subsection: 2, subsubsection: 3 }
const SECTION_COUNTERS = ['chapter', 'section', 'subsection', 'subsubsection']
export const NUMBERED_MATH = new Set(['equation', 'align', 'gather', 'alignat', 'flalign', 'multline', 'eqnarray'])
const FLOATS = { figure: 'figure', 'figure*': 'figure', table: 'table', 'table*': 'table' }
export const REF_MACROS = new Set(['ref', 'eqref', 'autoref', 'cref', 'Cref', 'pageref', 'nameref'])
// a definition's body is not content: a \footnote or \section inside it must not count
const DEFINITIONS = new Set([
    'newcommand',
    'renewcommand',
    'providecommand',
    'DeclareMathOperator',
    'def',
    'newenvironment',
    'renewenvironment',
])
export const CITE_MACROS = new Set(['cite', 'citep', 'citet', 'parencite', 'textcite', 'autocite'])

export function newCounters() {
    return { chapter: 0, section: 0, subsection: 0, subsubsection: 0, equation: 0, figure: 0, table: 0, footnote: 0 }
}

export const envName = node => (typeof node.env === 'string' ? node.env : node.env ? printRaw(node.env) : '')
export const lastArg = node => node.args?.[node.args.length - 1]
export const argText = arg => (arg ? printRaw(arg.content) : '').trim()
const isStarred = node => node.args?.some(a => printRaw(a.content) === '*' && a.openMark === '')

function prefix(st) {
    return st.chapter > 0 ? `${st.chapter}.` : ''
}

/** Splits a math environment's content into rows at top-level \\ . */
export function mathRows(nodes) {
    const rows = [[]]
    for (const node of nodes) {
        if (node.type === 'macro' && node.content === '\\') rows.push([])
        else rows[rows.length - 1].push(node)
    }
    return rows
}

/** Index of the {group} argument following a math macro the parser left without arguments, or -1. */
export function nextGroup(nodes, i) {
    let j = i + 1
    while (nodes[j]?.type === 'whitespace') j++
    return nodes[j]?.type === 'group' ? j : -1
}

/** \tag{A} inside math: the parser attaches no argument, the label is the following group. */
export function tagValue(nodes, i) {
    const attached = argText(lastArg(nodes[i]))
    if (attached) return attached
    const group = nextGroup(nodes, i)
    return group >= 0 ? printRaw(nodes[group].content).trim() : '??'
}

function rowNumbering(row, st) {
    const has = name => row.some(n => n.type === 'macro' && n.content === name)
    const labels = row.filter(n => n.type === 'macro' && n.content === 'label').map(n => argText(lastArg(n)))
    if (has('nonumber') || has('notag')) return { value: null, labels }
    const tag = row.findIndex(n => n.type === 'macro' && n.content === 'tag')
    if (tag >= 0) return { value: tagValue(row, tag), labels, manual: true }
    st.equation++
    return { value: `${prefix(st)}${st.equation}`, labels }
}

/**
 * Walks nodes in document order, updating counters in `st` and calling optional hooks:
 * section(node, value|null), math(node, rows|null), caption(node, kind, value), label(node, key, value),
 * footnote(node, n), cite(node, keys), ref(node, key), float(node, kind).
 */
export function walk(nodes, st, hooks) {
    for (const node of nodes) walkNode(node, st, hooks)
}

function walkNode(node, st, hooks) {
    switch (node.type) {
        case 'macro':
            return walkMacro(node, st, hooks)
        case 'mathenv': {
            const name = envName(node)
            if (!NUMBERED_MATH.has(name)) return hooks.math?.(node, null)
            const rows = name === 'equation' || name === 'multline' ? [node.content] : mathRows(node.content)
            const numbered = rows.map(row => rowNumbering(row, st))
            if (name === 'multline')
                numbered.forEach((r, i) => {
                    if (i < numbered.length - 1) r.value = null
                })
            for (const r of numbered) for (const key of r.labels) hooks.label?.(null, key, r.value ?? st.labelValue)
            return hooks.math?.(node, numbered)
        }
        case 'displaymath':
        case 'inlinemath':
            return hooks.math?.(node, null)
        case 'environment': {
            const kind = FLOATS[envName(node)]
            const outer = st.float
            if (kind) {
                st.float = kind
                hooks.float?.(node, kind)
            }
            for (const arg of node.args ?? []) walk(arg.content, st, hooks)
            walk(node.content, st, hooks)
            st.float = outer
            return
        }
        case 'group':
            return walk(node.content, st, hooks)
    }
}

function walkMacro(node, st, hooks) {
    const name = node.content
    if (DEFINITIONS.has(name)) return
    if (name in SECTION_LEVEL) {
        let value = null
        if (!isStarred(node)) {
            const level = SECTION_LEVEL[name]
            st[SECTION_COUNTERS[level]]++
            for (const lower of SECTION_COUNTERS.slice(level + 1)) st[lower] = 0
            if (level === 0) st.equation = st.figure = st.table = 0
            const parts = SECTION_COUNTERS.slice(st.chapter > 0 ? 0 : 1, level + 1).map(c => st[c])
            value = parts.join('.')
            st.labelValue = value
        }
        hooks.section?.(node, value)
    } else if (name === 'label') {
        hooks.label?.(node, argText(lastArg(node)), st.labelValue)
        return
    } else if (name === 'caption' && st.float) {
        st[st.float]++
        st.labelValue = `${prefix(st)}${st[st.float]}`
        hooks.caption?.(node, st.float, st.labelValue)
    } else if (name === 'footnote') {
        st.footnote++
        hooks.footnote?.(node, st.footnote)
    } else if (CITE_MACROS.has(name)) {
        hooks.cite?.(
            node,
            argText(lastArg(node))
                .split(',')
                .map(k => k.trim())
                .filter(Boolean),
        )
        return
    } else if (REF_MACROS.has(name)) {
        hooks.ref?.(node, argText(lastArg(node)))
        return
    }
    for (const arg of node.args ?? []) walk(arg.content, st, hooks)
}
