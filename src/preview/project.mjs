// Turns a multi-file LaTeX project into an ordered list of rendered blocks. Each keystroke re-parses only
// the changed paragraph (ChunkParser cache) and re-renders only blocks whose source or numbering changed.
import crypto from 'node:crypto'
import path from 'node:path'
import { listNewcommands } from '@unified-latex/unified-latex-util-macros'
import { printRaw } from '@unified-latex/unified-latex-util-print-raw'
import { ChunkParser, splitChunks, findMarkerLine } from './chunks.mjs'
import { walk, newCounters, lastArg, argText, REF_MACROS } from './numbering.mjs'
import { renderChunk, expandUserMacros } from './render.mjs'
import { parseBib } from './bib.mjs'
import { simpleDefs, environmentDefs, expandEnvironments, usesInternals } from './definitions.mjs'
import { documentSetup, pageLayout, classHeader } from './classes.mjs'

const MAX_INCLUDE_DEPTH = 8
const TITLE_MACROS = ['title', 'author', 'date']

const hash = text => crypto.createHash('sha1').update(text).digest('base64url').slice(0, 16)
const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function includeTarget(node) {
    return node.type === 'macro' && (node.content === 'input' || node.content === 'include') ? argText(lastArg(node)) : null
}

/** Names given to \includegraphics anywhere in `nodes`. */
function imageNames(nodes, out = []) {
    for (const node of nodes ?? []) {
        if (node.type === 'macro' && node.content === 'includegraphics') out.push(argText(lastArg(node)))
        for (const arg of node.args ?? []) imageNames(arg.content, out)
        if (Array.isArray(node.content)) imageNames(node.content, out)
    }
    return out
}

/** Names of all macros and environments used in `nodes`. */
function usedNames(nodes, out = new Set()) {
    for (const node of nodes ?? []) {
        if (node.type === 'macro') out.add(node.content)
        if (node.type === 'environment') out.add(`env:${typeof node.env === 'string' ? node.env : printRaw(node.env)}`)
        for (const arg of node.args ?? []) usedNames(arg.content, out)
        if (Array.isArray(node.content)) usedNames(node.content, out)
    }
    return [...out]
}

/** Local class and package files a \documentclass / \usepackage line refers to (only those in the project). */
function localDefinitionFiles(node, rootDir) {
    if (node.type !== 'macro' || !node.args) return []
    if (node.content === 'documentclass') return [path.resolve(rootDir, `${argText(lastArg(node))}.cls`)]
    if (node.content === 'usepackage')
        return argText(lastArg(node))
            .split(',')
            .map(p => path.resolve(rootDir, `${p.trim()}.sty`))
    return []
}

/** \ref-like macros inside math (the counter walk does not enter math). */
function mathRefs(nodes, refs) {
    for (const node of nodes ?? []) {
        if (node.type === 'macro' && REF_MACROS.has(node.content)) refs.add(argText(lastArg(node)))
        if (Array.isArray(node.content)) mathRefs(node.content, refs)
    }
}

/** Cache-key part for an image lookup: changes when it is found or the file changes, not with its data URI. */
function imageVersion(image) {
    return image ? (image.version ?? (image.pending ? 'pending' : 'pdf')) : 'none'
}

function texPath(dir, name) {
    return path.resolve(dir, path.extname(name) ? name : `${name}.tex`)
}

/**
 * @param {object} host
 *   readText(fsPath): string|undefined   live editor text, else disk
 *   resolveImage(rootDir, name): {src}|{pdf:true}|null
 */
export class LivePreviewModel {
    constructor(host) {
        this.host = host
        this.parser = new ChunkParser()
        this.htmlByKey = new Map()
        this.factsByAst = new WeakMap() // entries go away with the parse cache's ASTs
    }

    /** @returns {{blocks: {id, key, file, line, endLine, html?}[], files: string[], page: object, stats: object}} */
    update(rootFile) {
        const started = performance.now()
        const parsesBefore = this.parser.parses
        const files = new Set()
        const preamble = []
        const segments = []
        const rootDir = path.dirname(rootFile)
        this.collect(rootFile, rootDir, [], files, preamble, segments, true)
        const setup = documentSetup(preamble.map(c => c.ast.content))
        const header = this.headerSegment(rootFile, setup, preamble)
        if (header) segments.unshift(header)
        const analysis = this.analyze(preamble, segments, rootDir)
        const blocks = []
        const occurrences = new Map()
        const nextHtml = new Map()
        let rendered = 0
        for (const seg of segments) {
            const key = hash(`${seg.file}\0${seg.text}\0${seg.index}\0${JSON.stringify(seg.context)}`)
            let html = this.htmlByKey.get(key) ?? nextHtml.get(key)
            if (html === undefined) {
                html = this.renderSegment(seg, analysis, rootDir)
                rendered++
            }
            nextHtml.set(key, html)
            const n = (occurrences.get(key) ?? 0) + 1
            occurrences.set(key, n)
            blocks.push({ id: `${key}.${n}`, key, file: seg.file, line: seg.startLine, endLine: seg.endLine, html })
        }
        this.htmlByKey = nextHtml // drop HTML of blocks that no longer exist: memory stays proportional to the document
        this.parser.sweep()
        return {
            blocks,
            files: [...files],
            page: pageLayout(setup),
            stats: { ms: performance.now() - started, parsed: this.parser.parses - parsesBefore, rendered, blocks: blocks.length },
        }
    }

    /** Content the document class prints by itself at \begin{document}, as a block mapped to the root's preamble. */
    headerSegment(rootFile, setup, preamble) {
        const own = preamble.filter(c => c.file === rootFile)
        const nodes = classHeader(
            setup,
            own.map(c => c.ast.content),
        )
        if (!nodes) return null
        const text = printRaw(nodes)
        // a stable root object per header text keeps the per-AST caches (facts, expansions) warm
        this.headerAsts ??= new Map()
        if (!this.headerAsts.has(text)) this.headerAsts = new Map([[text, { type: 'root', content: nodes }]])
        const ast = this.headerAsts.get(text)
        const first = own.find(c => c.ast.content.some(n => n.type === 'macro' && (n.content === 'name' || n.content === 'address')))
        const last = own.findLast(c => c.ast.content.some(n => n.type === 'macro' && n.content === 'address')) ?? first
        return {
            file: rootFile,
            text,
            index: 'header',
            ast,
            nodes: ast.content,
            startLine: first?.startLine ?? 0,
            endLine: last?.endLine ?? 0,
        }
    }

    /**
     * Reads `file`, splits it into chunks and expands top-level \input/\include in place.
     * `ancestors` (the include chain) stops cycles; the same file included twice renders twice.
     */
    collect(file, rootDir, ancestors, files, preamble, segments, isRoot) {
        if (ancestors.includes(file) || ancestors.length > MAX_INCLUDE_DEPTH) return
        const text = this.host.readText(file)
        if (text === undefined) {
            segments.push(missingSegment(file))
            return
        }
        files.add(file)
        const chain = [...ancestors, file]
        const lines = text.split(/\r?\n/)
        let from = 0
        let to = lines.length
        if (isRoot) {
            const begin = findMarkerLine(lines, '\\begin{document}')
            if (begin >= 0) {
                this.collectPreamble(lines, begin, file, rootDir, chain, files, preamble)
                const end = findMarkerLine(lines, '\\end{document}', begin + 1)
                from = begin + 1
                to = end >= 0 ? end : lines.length
            }
        }
        for (const chunk of splitChunks(lines, from, to, this.parser)) {
            let index = 0
            let pending = []
            const flush = () => {
                if (pending.some(n => n.type !== 'whitespace' && n.type !== 'parbreak' && n.type !== 'comment')) {
                    segments.push({ ...chunk, file, index: index++, nodes: pending })
                }
                pending = []
            }
            for (const node of chunk.ast.content) {
                const target = includeTarget(node)
                if (target === null) {
                    pending.push(node)
                    continue
                }
                flush()
                this.collect(texPath(rootDir, target), rootDir, chain, files, preamble, segments, false)
            }
            flush()
        }
    }

    /** Preamble chunks (definitions, \title), following \input/\include of macro files. */
    collectPreamble(lines, to, file, rootDir, chain, files, preamble) {
        for (const chunk of splitChunks(lines, 0, to, this.parser)) {
            preamble.push({ ...chunk, file })
            for (const node of chunk.ast.content) {
                const target = includeTarget(node)
                // a class or package file in the project (resume.cls) is read for its definitions
                for (const local of localDefinitionFiles(node, rootDir)) {
                    if (chain.includes(local)) continue
                    const text = this.host.readText(local)
                    if (text === undefined) continue
                    files.add(local)
                    const sub = text.split(/\r?\n/)
                    this.collectPreamble(sub, sub.length, local, rootDir, [...chain, local], files, preamble)
                }
                if (target === null) continue
                const included = texPath(rootDir, target)
                if (chain.includes(included) || chain.length > MAX_INCLUDE_DEPTH) continue
                const text = this.host.readText(included)
                if (text === undefined) continue
                files.add(included)
                const sub = text.split(/\r?\n/)
                this.collectPreamble(sub, sub.length, included, rootDir, [...chain, included], files, preamble)
            }
        }
    }

    /** Facts about a segment that do not depend on counters, cached per parsed chunk until it changes. */
    segmentFacts(ast, index, nodes) {
        let byIndex = this.factsByAst.get(ast)
        if (!byIndex) this.factsByAst.set(ast, (byIndex = new Map()))
        let facts = byIndex.get(index)
        if (!facts) {
            const defs = [...listNewcommands({ type: 'root', content: nodes }), ...simpleDefs(nodes)].filter(
                d => !usesInternals([d.body].flat()),
            )
            facts = {
                defs,
                envs: environmentDefs(nodes),
                title: {},
                images: imageNames(nodes),
                macros: usedNames(nodes),
                maketitle: false,
                bibNames: null,
            }
            for (const node of nodes) {
                if (node.type !== 'macro') continue
                if (TITLE_MACROS.includes(node.content)) facts.title[node.content] = lastArg(node)?.content
                if (node.content === 'maketitle') facts.maketitle = true
                if (node.content === 'bibliography' || node.content === 'printbibliography') {
                    facts.bibNames = argText(lastArg(node))
                        .split(',')
                        .map(s => s.trim())
                        .filter(Boolean)
                }
            }
            byIndex.set(index, facts)
        }
        return facts
    }

    /** Document-order pass: labels, citation order, macro definitions, title, and per-segment context. */
    analyze(preamble, segments, rootDir) {
        const defs = []
        const envs = new Map()
        const title = {}
        const addFacts = facts => {
            defs.push(...facts.defs)
            for (const [name, def] of facts.envs) envs.set(name, def)
            Object.assign(title, facts.title)
        }
        for (const chunk of preamble) addFacts(this.segmentFacts(chunk.ast, 'preamble', chunk.ast.content))
        const bodyFacts = segments.map(seg => seg.nodes && this.segmentFacts(seg.ast, seg.index, seg.nodes))
        bodyFacts.forEach(facts => facts && addFacts(facts))
        const defsKey =
            defs.length + envs.size > 0
                ? hash(
                      JSON.stringify([
                          defs.map(d => [d.name, d.signature, printRaw(d.body)]),
                          [...envs].map(([name, e]) => [name, e.nargs, printRaw(e.begin), printRaw(e.end)]),
                      ]),
                  )
                : ''
        // names a block may use that the document defines: macros, and environments as "env:name"
        const defNames = new Set([...defs.map(d => d.name), ...[...envs.keys()].map(name => `env:${name}`)])
        // keys are user text (\label{constructor}, @book{__proto__}): no inherited properties
        const labels = Object.create(null)
        const citeNumbers = Object.create(null)
        const st = newCounters()
        const perSegment = []
        let bibNames = []
        segments.forEach((seg, i) => {
            const facts = bodyFacts[i]
            if (!facts) return
            const start = { ...st }
            const refs = new Set()
            const cites = new Set()
            const flags = new Set()
            // count on the macro-expanded text, exactly as renderChunk does (\newcommand{\sec}[1]{\section{#1}})
            walk(this.expandedNodes(seg, facts, { defs, envs, defNames, defsKey }), st, {
                label: (node, key, value) => {
                    labels[key] = value ?? '??'
                },
                cite: (node, keys) =>
                    keys.forEach(k => {
                        cites.add(k)
                        citeNumbers[k] ??= Object.keys(citeNumbers).length + 1
                    }),
                ref: (node, key) => refs.add(key),
                math: node => mathRefs(node.content, refs),
            })
            if (facts.maketitle) flags.add('title')
            if (facts.bibNames) {
                flags.add('bib')
                bibNames = facts.bibNames
            }
            perSegment.push({ seg, facts, start, end: { ...st }, refs, cites, flags })
        })
        const bib = Object.assign(
            Object.create(null),
            ...bibNames.map(name =>
                parseBib(this.host.readText(path.resolve(rootDir, name.endsWith('.bib') ? name : `${name}.bib`)) ?? ''),
            ),
        )
        const titleKey = JSON.stringify(Object.entries(title).map(([k, v]) => [k, printRaw(v ?? [])]))
        for (const { seg, facts, start, end, refs, cites, flags } of perSegment) {
            // Only what this block depends on goes into its cache key, so editing one paragraph does not
            // re-render the rest unless its numbers, references or citations really change.
            const touched = Object.keys(start).filter(k => start[k] !== end[k])
            seg.context = {
                counters: touched.length > 0 ? start : null,
                refs: [...refs].map(k => [k, labels[k] ?? '??']),
                cites: [...cites].map(k => [k, citeNumbers[k]]),
                defs: facts.macros.some(name => defNames.has(name)) ? defsKey : '',
                title: flags.has('title') ? titleKey : null,
                bib: flags.has('bib') ? JSON.stringify([citeNumbers, bib]) : null,
                // an image found later, or changed on disk, re-renders its block
                images: facts.images.map(name => imageVersion(this.host.resolveImage(rootDir, name))),
            }
            seg.counters = start
        }
        return { labels, citeNumbers, bib, defs, envs, title }
    }

    /** Segment nodes with user environments and macros expanded, cached until the definitions change. */
    expandedNodes(seg, facts, { defs, envs, defNames, defsKey }) {
        if (!facts.macros.some(name => defNames.has(name))) return seg.nodes
        if (facts.expandedFor !== defsKey) {
            const root = structuredClone({ type: 'root', content: seg.nodes })
            root.content = expandEnvironments(root.content, envs)
            expandUserMacros(root, defs)
            facts.expanded = root.content
            facts.expandedFor = defsKey
        }
        return facts.expanded
    }

    renderSegment(seg, analysis, rootDir) {
        if (seg.missing) return seg.html
        try {
            const html = renderChunk(
                { type: 'root', content: seg.nodes },
                {
                    counters: seg.counters,
                    labels: analysis.labels,
                    citeNumbers: analysis.citeNumbers,
                    bib: analysis.bib,
                    defs: analysis.defs,
                    envs: analysis.envs,
                    title: analysis.title,
                    resolveImage: name => this.host.resolveImage(rootDir, name),
                },
            )
            return seg.ast.parseError ? `${html}<div class="lp-error">Parse error: ${escapeHtml(seg.ast.parseError)}</div>` : html
        } catch (e) {
            // One broken block must not blank the preview: show its source with the error.
            return (
                `<div class="lp-error">Live preview could not render this block: ${escapeHtml(String(e.message))}</div>` +
                `<pre class="lp-source">${escapeHtml(seg.text)}</pre>`
            )
        }
    }
}

function missingSegment(file) {
    return {
        file,
        text: '',
        index: 0,
        startLine: 0,
        endLine: 0,
        missing: true,
        context: { missing: true },
        html: `<div class="lp-error">File not found: ${escapeHtml(file)}</div>`,
    }
}
