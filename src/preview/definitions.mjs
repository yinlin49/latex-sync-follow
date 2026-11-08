// User definitions the preview applies itself: parameterless \def and \newenvironment, read from the
// document and from .cls/.sty files that live in the project (a template's resume.cls, say).
import { printRaw } from '@unified-latex/unified-latex-util-print-raw'
import { isHtmlLike } from '@unified-latex/unified-latex-util-html-like'
import { argText, envName } from './numbering.mjs'

const isBlank = n => n.type === 'whitespace' || n.type === 'comment' || n.type === 'parbreak' || isHtmlLike(n)
const ENV_DEFINERS = new Set(['newenvironment', 'renewenvironment'])

/** True for bodies using LaTeX internals (\@..., \makeatletter): those cannot be expanded faithfully. */
export function usesInternals(body) {
    return body.some(
        n =>
            (n.type === 'macro' && (n.content.includes('@') || n.content === 'makeatletter')) ||
            (Array.isArray(n.content) && usesInternals(n.content)) ||
            (n.args ?? []).some(a => usesInternals(a.content)),
    )
}

/** `\def\name{body}` without parameters, in \newcommand form ({ name, signature, body }). */
export function simpleDefs(nodes) {
    const defs = []
    for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].type !== 'macro' || nodes[i].content !== 'def') continue
        let j = i + 1
        while (nodes[j] && isBlank(nodes[j])) j++
        const name = nodes[j]
        if (name?.type !== 'macro') continue
        j++
        while (nodes[j] && isBlank(nodes[j])) j++
        // `\def\x#1{...}` (parameters) and `\def\@x{...}` (internal names) are left alone
        if (nodes[j]?.type === 'group' && !usesInternals(nodes[j].content)) {
            defs.push({ name: name.content, signature: '', body: nodes[j].content })
        }
    }
    return defs
}

/** \newenvironment{name}[n][default]{begin}{end} -> Map(name, { nargs, optional, begin, end }) */
export function environmentDefs(nodes) {
    const envs = new Map()
    for (const node of nodes) {
        if (node.type !== 'macro' || !ENV_DEFINERS.has(node.content) || !node.args) continue
        const args = node.args
        const name = argText(args[2])
        if (!name) continue
        envs.set(name, {
            nargs: Number(argText(args[3])) || 0,
            optional: args[4]?.openMark === '[' ? args[4].content : null,
            begin: args[5]?.content ?? [],
            end: args[6]?.content ?? [],
        })
    }
    return envs
}

/** Replaces #1..#9 (the parser leaves them as the strings "#" and "1") with argument nodes. */
function substitute(nodes, args) {
    const out = []
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]
        const next = nodes[i + 1]
        if (node.type === 'string' && node.content === '#' && next?.type === 'string' && /^\d/.test(next.content)) {
            out.push(...structuredClone(args[Number(next.content[0]) - 1] ?? []))
            if (next.content.length > 1) out.push({ type: 'string', content: next.content.slice(1) })
            i++
            continue
        }
        if (node.type === 'hash_number') {
            out.push(...structuredClone(args[node.number - 1] ?? []))
            continue
        }
        if (Array.isArray(node.content)) node.content = substitute(node.content, args)
        for (const arg of node.args ?? []) arg.content = substitute(arg.content, args)
        out.push(node)
    }
    return out
}

const skipBlank = (nodes, i) => {
    while (nodes[i] && isBlank(nodes[i])) i++
    return i
}

/**
 * A begin body may open an environment that the end body closes (\begin{list}...\item[] / \end{list}).
 * The parser sees an unmatched \begin and \end; rebuild the environment node around the content.
 */
function joinOpenEnvironment(begin, rest) {
    const open = begin.findIndex(n => n.type === 'macro' && n.content === 'begin')
    if (open < 0) return [...begin, ...rest]
    let i = skipBlank(begin, open + 1)
    if (begin[i]?.type !== 'group') return [...begin, ...rest]
    const name = printRaw(begin[i].content).trim()
    const args = []
    for (i = skipBlank(begin, i + 1); begin[i]?.type === 'group'; i = skipBlank(begin, i + 1)) {
        args.push({ type: 'argument', openMark: '{', closeMark: '}', content: begin[i].content })
    }
    const close = rest.findIndex(
        (n, k) => n.type === 'macro' && n.content === 'end' && printRaw(rest[skipBlank(rest, k + 1)]?.content ?? []).trim() === name,
    )
    if (close < 0) return [...begin, ...rest]
    const after = skipBlank(rest, close + 1) + 1
    const environment = { type: 'environment', env: name, args, content: [...begin.slice(i), ...rest.slice(0, close)] }
    return [...begin.slice(0, open), environment, ...rest.slice(after)]
}

function expandEnvironment(node, def) {
    // the parser does not know user environments: their {arguments} are the leading groups of the content
    const content = [...node.content]
    const args = def.optional ? [def.optional] : []
    while (args.length < def.nargs) {
        const i = skipBlank(content, 0)
        if (content[i]?.type !== 'group') break
        args.push(content[i].content)
        content.splice(0, i + 1)
    }
    const begin = substitute(structuredClone(def.begin), args)
    const end = substitute(structuredClone(def.end), args)
    return joinOpenEnvironment(begin, [...content, ...end])
}

/** Expands user environments in `nodes` (mutates nested arrays of a cloned tree), returns the new array. */
export function expandEnvironments(nodes, envs, depth = 0) {
    if (envs.size === 0 || depth > 8) return nodes
    const out = []
    for (const node of nodes) {
        if (node.type === 'environment' && envs.has(envName(node))) {
            out.push(...expandEnvironments(expandEnvironment(node, envs.get(envName(node))), envs, depth + 1))
            continue
        }
        if (Array.isArray(node.content)) node.content = expandEnvironments(node.content, envs, depth)
        for (const arg of node.args ?? []) arg.content = expandEnvironments(arg.content, envs, depth)
        out.push(node)
    }
    return out
}
