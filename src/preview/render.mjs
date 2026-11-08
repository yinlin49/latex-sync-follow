// Renders one parsed chunk to HTML: LaTeX AST -> (numbering, refs, math, images) -> unified-latex-to-hast.
import katex from 'katex'
import { unified } from 'unified'
import { toHtml } from 'hast-util-to-html'
import { unifiedLatexToHast } from '@unified-latex/unified-latex-to-hast'
import { htmlLike, isHtmlLike, isHtmlLikeTag, extractFromHtmlLike } from '@unified-latex/unified-latex-util-html-like'
import { printRaw } from '@unified-latex/unified-latex-util-print-raw'
import { attachMacroArgs } from '@unified-latex/unified-latex-util-arguments'
import { expandMacrosExcludingDefinitions } from '@unified-latex/unified-latex-util-macros'
import { walk, envName, lastArg, argText, nextGroup, REF_MACROS } from './numbering.mjs'
import { expandEnvironments } from './definitions.mjs'

// Links in the preview may only open web pages or mail: not vscode:, file: or javascript: URIs.
const SAFE_LINK = /^(?:https?:|mailto:|#)/i

// Layout-only commands with no visible content in a flowing HTML preview.
const IGNORED = new Set([
    'centering',
    'noindent',
    'indent',
    'vspace',
    'vfill',
    'newpage',
    'clearpage',
    'cleardoublepage',
    'pagebreak',
    'nopagebreak',
    'linebreak',
    'smallskip',
    'medskip',
    'bigskip',
    'hline',
    'toprule',
    'midrule',
    'bottomrule',
    'cline',
    'cmidrule',
    'label',
    'newcommand',
    'renewcommand',
    'providecommand',
    'DeclareMathOperator',
    'newenvironment',
    'renewenvironment',
    'def',
    'bibliographystyle',
    'protect',
    'phantomsection',
    'addcontentsline',
    'thispagestyle',
    'pagestyle',
    'setlength',
    'raggedright',
    'raggedleft',
    'par',
    'relax',
    'nonumber',
    'notag',
    'title',
    'author',
    'date',
    'thanks',
]) // \title etc. only store text that \maketitle shows
// Environments the stylesheet lays out; any other unknown environment is flagged as approximate.
const STYLED_ENVS = new Set([
    'figure',
    'figure*',
    'table',
    'table*',
    'center',
    'flushleft',
    'flushright',
    'quote',
    'quotation',
    'abstract',
    'minipage',
    'verse',
    'theorem',
    'lemma',
    'proof',
    'definition',
    'remark',
    'example',
])
const HEADING_TAG = { chapter: 'h1', section: 'h2', subsection: 'h3', subsubsection: 'h4', paragraph: 'h5' }
const FLOAT_LABEL = { figure: 'Figure', table: 'Table' }
const KATEX_CACHE_LIMIT = 4000
const katexCache = new Map()

const str = content => ({ type: 'string', content })
const replaceNode = (node, next) => {
    for (const key of Object.keys(node)) delete node[key]
    Object.assign(node, next)
}
const el = (tag, attributes, content = []) => htmlLike({ tag, attributes, content })

/** KaTeX with a bounded cache: identical formulas (very common) render once. */
export function renderMath(tex, displayMode) {
    const key = `${displayMode ? 'D' : 'I'}${tex}`
    let html = katexCache.get(key)
    if (html === undefined) {
        html = katex.renderToString(tex, { displayMode, throwOnError: false, strict: 'ignore', trust: false, output: 'html' })
        if (katexCache.size >= KATEX_CACHE_LIMIT) katexCache.delete(katexCache.keys().next().value)
        katexCache.set(key, html)
    }
    return html
}

/** Replaces \ref-like macros and drops \label/\nonumber/\notag/\tag inside math so KaTeX gets plain TeX. */
function mathTex(nodes, labels) {
    let tex = ''
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]
        if (node.type === 'macro' && REF_MACROS.has(node.content)) {
            const value = labels[argText(lastArg(node))] ?? '??'
            tex += node.content === 'eqref' ? `\\text{(${value})}` : `\\text{${value}}`
        } else if (node.type === 'macro' && ['label', 'nonumber', 'notag', 'tag'].includes(node.content)) {
            // in math the parser leaves the {argument} as the next node: drop it with the macro
            if (!node.args?.length && node.content !== 'nonumber' && node.content !== 'notag') {
                const group = nextGroup(nodes, i)
                if (group >= 0) i = group
            }
        } else if (node.type === 'group') {
            tex += `{${mathTex(node.content, labels)}}`
        } else {
            tex += printRaw(node)
        }
    }
    return tex
}

/** Expands the document's \newcommand macros in place (shared by analysis and rendering). */
export function expandUserMacros(ast, defs) {
    if (defs.length === 0) return
    attachMacroArgs(ast, Object.fromEntries(defs.map(d => [d.name, { signature: d.signature }])))
    expandMacrosExcludingDefinitions(ast, defs)
}

function mathEnvTex(node, rows, labels) {
    const name = envName(node)
    if (!rows) {
        const body = mathTex(node.content, labels)
        if (node.type === 'inlinemath') return { tex: body, display: false }
        if (node.type === 'displaymath') return { tex: body, display: true }
        return { tex: `\\begin{${name}}${body}\\end{${name}}`, display: true } // unnumbered: align*, gather*, ...
    }
    const tag = r => (r.value === null ? '' : `\\tag{${r.value}}`)
    if (name === 'equation') return { tex: `${mathTex(node.content, labels)}${tag(rows[0])}`, display: true }
    // multline is not supported by KaTeX: lay its lines out centred and keep the number on the last one.
    const env = name === 'multline' ? 'gather' : name === 'eqnarray' ? 'align' : name
    const contentRows = name === 'multline' ? [node.content] : null
    const texRows = (contentRows ?? splitRowsRaw(node.content)).map(
        (row, i) => `${mathTex(row, labels)}${rows[i] ? (rows[i].value === null ? '\\notag' : tag(rows[i])) : ''}`,
    )
    const args = name === 'alignat' ? printRaw(node.args ?? []) : ''
    return { tex: `\\begin{${env}}${args}${texRows.join('\\\\')}\\end{${env}}`, display: true }
}

function splitRowsRaw(nodes) {
    const rows = [[]]
    for (const node of nodes) {
        if (node.type === 'macro' && node.content === '\\') rows.push([])
        else rows[rows.length - 1].push(node)
    }
    return rows
}

/** Empty <span data-rl=N> markers before each node that starts a new source line (N = line within chunk). */
function insertLineAnchors(nodes, seen) {
    const out = []
    for (const node of nodes) {
        const line = node.position?.start.line
        if (line !== undefined && !seen.has(line) && node.type !== 'whitespace' && node.type !== 'parbreak') {
            seen.add(line)
            out.push(el('span', { class: 'lp-a', 'data-rl': String(line - 1) }))
        }
        // math and verbatim are other node types, so their content is never touched
        if (node.type === 'environment') node.content = insertLineAnchors(node.content, seen)
        out.push(node)
    }
    return out
}

/**
 * @param {object} chunkAst parsed chunk (not mutated)
 * @param {object} ctx { counters, labels, citeNumbers, bib, defs, title, resolveImage(path) }
 * @returns {string} HTML for the chunk
 */
export function renderChunk(chunkAst, ctx) {
    const ast = structuredClone(chunkAst)
    ast.content = insertLineAnchors(ast.content, new Set())
    ast.content = expandEnvironments(ast.content, ctx.envs ?? new Map())
    expandUserMacros(ast, ctx.defs)
    const footnotes = []
    const st = { ...ctx.counters }
    walk(ast.content, st, {
        section(node, value) {
            const title = lastArg(node)?.content ?? []
            const number = value ? [el('span', { class: 'lp-num' }, [str(value)])] : []
            replaceNode(node, el(HEADING_TAG[node.content] ?? 'h2', { class: 'lp-heading' }, [...number, ...title]))
        },
        math(node, rows) {
            const { tex, display } = mathEnvTex(node, rows, ctx.labels)
            const html = renderMath(tex, display)
            replaceNode(node, el(display ? 'div' : 'span', { class: display ? 'lp-math-d' : 'lp-math-i', 'data-katex': html }))
        },
        caption(node, kind, value) {
            replaceNode(
                node,
                el('div', { class: 'lp-caption' }, [str(`${FLOAT_LABEL[kind]} ${value}: `), ...(lastArg(node)?.content ?? [])]),
            )
        },
        footnote(node, n) {
            footnotes.push(
                el('div', { class: 'lp-footnote' }, [el('sup', {}, [str(String(n))]), str(' '), ...(lastArg(node)?.content ?? [])]),
            )
            replaceNode(node, el('sup', { class: 'lp-fnref' }, [str(String(n))]))
        },
        cite(node, keys) {
            const parts = keys.map(k => ctx.citeNumbers[k] ?? '?').join(', ')
            const note =
                node.args?.length > 1 && node.args[node.args.length - 2].openMark === '['
                    ? `, ${argText(node.args[node.args.length - 2])}`
                    : ''
            replaceNode(node, el('span', { class: 'lp-cite' }, [str(`[${parts}${note}]`)]))
        },
        ref(node, key) {
            const value = ctx.labels[key] ?? '??'
            replaceNode(node, el('span', { class: 'lp-ref' }, [str(node.content === 'eqref' ? `(${value})` : value)]))
        },
    })
    ast.content = transformMacros(ast.content, ctx)
    if (footnotes.length > 0) ast.content.push(el('div', { class: 'lp-footnotes' }, footnotes))
    const hast = unified().use(unifiedLatexToHast).runSync(ast)
    finishHast(hast)
    // unified 10 types its tree with @types/hast 2, hast-util-to-html 9 with @types/hast 3: same shape at runtime
    return toHtml(/** @type {any} */ (hast), { allowDangerousHtml: true })
}

function transformMacros(nodes, ctx, inTable = false) {
    const out = []
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]
        if (node.type === 'macro' && DECLARATIONS[node.content] && !inTable) {
            // {\bf ...}, \em ...: a declaration styles the rest of its group or environment
            // (TeX drops the space after a control word)
            const rest = nodes.slice(nodes[i + 1]?.type === 'whitespace' ? i + 2 : i + 1)
            out.push(el('span', { class: `lp-${DECLARATIONS[node.content]}` }, transformMacros(rest, ctx)))
            break
        }
        if (node.type === 'macro') {
            // \& etc. as text: unified-latex-to-hast drops the space after a control symbol ("Backend &APIs");
            // in tables the parser's & separator must stay a macro for the column split
            if (ESCAPED.has(node.content) && !inTable) {
                out.push(str(node.content))
                continue
            }
            if (LENGTH_REGISTERS.has(node.content) && !node.args?.length) {
                i = skipDimension(nodes, i)
                continue
            }
            const skip = node.content === 'vspace' || node.content === 'vspace*' ? lengthEm(argText(lastArg(node))) : SKIPS[node.content]
            if (skip !== undefined && skip !== null && !inTable) {
                // TeX adds \vspace to \parskip: a negative one becomes a negative margin, which collapses
                // with the paragraph margin into their sum; a positive one is a fixed gap (margins would max)
                out.push(el('div', { class: 'lp-vspace', style: skip < 0 ? `margin-top:${skip}em` : `height:${skip}em` }))
                continue
            }
            if (IGNORED.has(node.content)) continue
            if (GROUP_MACROS[node.content]) {
                const [content, last] = groupArgument(nodes, i)
                if (content) {
                    out.push(GROUP_MACROS[node.content](transformMacros(content, ctx, inTable)))
                    i = last
                    continue
                }
            }
            // in tabular/array, \\ separates rows and unified-latex-to-hast needs it as is
            if (!inTable && (node.content === 'hfill' || node.content === 'hfil')) {
                out.push(FILL)
                continue
            }
            if (!inTable && node.content === '\\') {
                out.push(BREAK)
                continue
            }
            const replaced = MACRO_RENDERERS[node.content]?.(node, ctx)
            if (replaced) {
                out.push(replaced)
                continue
            }
            for (const arg of node.args ?? []) arg.content = transformMacros(arg.content, ctx)
        } else if (node.type === 'parbreak' && !inTable) {
            out.push(PARBREAK)
            continue
        } else if (node.type === 'environment' && envName(node) === 'list') {
            out.push(renderList(node, ctx))
            continue
        } else if (node.type === 'environment' || node.type === 'group') {
            const table = node.type === 'environment' ? TABLE_ENVS.has(envName(node)) : inTable
            node.content = transformMacros(node.content, ctx, table)
            if (node.type === 'environment' && !STYLED_ENVS.has(envName(node)) && !KNOWN_TO_HAST.has(envName(node))) {
                out.push(
                    el(
                        'div',
                        {
                            class: 'lp-unsupported-env',
                            'data-name': envName(node),
                            title: `\\begin{${envName(node)}} is approximated by the live preview`,
                        },
                        approximateEnvironment(node.content),
                    ),
                )
                continue
            }
        }
        out.push(node)
    }
    return layoutLines(out)
}

const DECLARATIONS = {
    bf: 'bf',
    bfseries: 'bf',
    em: 'em',
    it: 'it',
    itshape: 'it',
    sl: 'it',
    slshape: 'it',
    sc: 'sc',
    scshape: 'sc',
    tt: 'tt',
    ttfamily: 'tt',
    sf: 'sf',
    sffamily: 'sf',
    rm: 'rm',
    rmfamily: 'rm',
    tiny: 'size-tiny',
    scriptsize: 'size-scriptsize',
    footnotesize: 'size-footnotesize',
    small: 'size-small',
    normalsize: 'size-normalsize',
    large: 'size-large',
    Large: 'size-Large',
    LARGE: 'size-LARGE',
    huge: 'size-huge',
    Huge: 'size-Huge',
}
const ESCAPED = new Set(['&', '%', '$', '#', '_', '{', '}'])
// \smallskip, \medskip, \bigskip at 10pt (3pt, 6pt, 12pt), in em
const SKIPS = { smallskip: 0.3, medskip: 0.6, bigskip: 1.2 }
// `\itemsep -3pt`: a length assignment prints nothing; its value must not show up as text
const LENGTH_REGISTERS = new Set([
    'itemsep',
    'parsep',
    'parskip',
    'topsep',
    'partopsep',
    'leftmargin',
    'rightmargin',
    'labelwidth',
    'labelsep',
    'itemindent',
    'listparindent',
    'parindent',
    'baselineskip',
    'tabcolsep',
    'arraycolsep',
])

function skipDimension(nodes, i) {
    let j = i + 1
    while (
        j < nodes.length &&
        (nodes[j].type === 'whitespace' ||
            (nodes[j].type === 'string' &&
                /^(?:[-+=.\d]+|pt|bp|em|ex|in|cm|mm|pc|sp|plus|minus|fil+|[-+=.\d]+(?:pt|bp|em|ex|in|cm|mm|pc|sp))$/.test(
                    nodes[j].content,
                )))
    ) {
        j++
    }
    // stop before trailing whitespace so words around the assignment stay separated
    while (j - 1 > i && nodes[j - 1].type === 'whitespace') j--
    return j - 1
}

/**
 * An environment we do not know (e.g. one defined by a document class): show a leading {title} argument
 * as a heading and, if it holds \item entries, lay them out as a list.
 */
function approximateEnvironment(content) {
    const first = content.findIndex(n => n.type !== 'whitespace' && n.type !== 'comment' && !isHtmlLike(n))
    const title = content[first]?.type === 'group' ? [el('div', { class: 'lp-env-title' }, content[first].content)] : []
    const body = title.length ? content.filter((_, i) => i !== first) : content
    const start = body.findIndex(n => n.type === 'macro' && n.content === 'item')
    if (start < 0) return [...title, ...body]
    // the parser puts an item's text in the last argument of \item inside itemize; do the same here
    const items = []
    for (const node of body.slice(start)) {
        if (node.type === 'macro' && node.content === 'item') {
            items.push({
                ...node,
                args: [...(node.args ?? []).slice(0, -1), { type: 'argument', openMark: '', closeMark: '', content: [] }],
            })
        } else {
            items[items.length - 1].args.at(-1).content.push(node)
        }
    }
    return [...title, ...body.slice(0, start), { type: 'environment', env: 'itemize', content: items }]
}

const TABLE_ENVS = new Set(['tabular', 'tabular*', 'tabularx', 'array'])
const KNOWN_TO_HAST = new Set(['itemize', 'enumerate', 'description', ...TABLE_ENVS, 'verbatim', 'document'])

const MACRO_RENDERERS = {
    includegraphics(node, ctx) {
        const file = argText(lastArg(node))
        const options = node.args?.find(a => a.openMark === '[')
        const width = /(?:^|,)\s*width\s*=\s*([\d.]*)\s*\\(?:textwidth|linewidth|columnwidth)/.exec(
            options ? printRaw(options.content) : '',
        )
        const style = width ? `width:${Math.round(parseFloat(width[1] || '1') * 100)}%` : 'max-width:100%'
        const image = ctx.resolveImage(file)
        if (!image) return el('span', { class: 'lp-missing', title: 'Image not found by the live preview' }, [str(`[image: ${file}]`)])
        if (image.pending) return el('span', { class: 'lp-missing' }, [str(`[loading image: ${file}]`)])
        if (image.pdf)
            return el('span', { class: 'lp-missing', title: 'PDF graphics appear in the exported PDF' }, [str(`[PDF figure: ${file}]`)])
        return el('img', { class: 'lp-img', src: image.src, style, alt: file })
    },
    maketitle(node, ctx) {
        const { title, author, date } = ctx.title
        return el('div', { class: 'lp-title' }, [
            el('h1', {}, title ?? []),
            ...(author ? [el('div', { class: 'lp-author' }, author)] : []),
            ...(date ? [el('div', { class: 'lp-date' }, date)] : []),
        ])
    },
    bibliography(node, ctx) {
        return references(ctx)
    },
    printbibliography(node, ctx) {
        return references(ctx)
    },
    input: nestedInclude,
    include: nestedInclude,
    hspace(node) {
        const em = lengthEm(argText(lastArg(node)))
        return em === null ? str(' ') : el('span', { class: 'lp-hspace', style: `margin-left:${em}em` })
    },
    hrule: () => el('hr', { class: 'lp-hrule' }),
}

const PT_PER_UNIT = { em: 10, ex: 4.3, pt: 1, bp: 1.00375, in: 72.27, cm: 28.45, mm: 2.845 }

/** A TeX length as em of a 10pt font, or null. */
function lengthEm(text) {
    const m = /^\s*(-?[\d.]+)\s*(em|ex|pt|bp|in|cm|mm)\s*$/.exec(text)
    return m ? Math.round(((parseFloat(m[1]) * PT_PER_UNIT[m[2]]) / 10) * 1000) / 1000 : null
}

// \foo{...} macros the parser may leave without an attached argument (the {...} is the next group)
const GROUP_MACROS = {
    MakeUppercase: content => el('span', { class: 'lp-upper' }, content),
    uppercase: content => el('span', { class: 'lp-upper' }, content),
    MakeLowercase: content => el('span', { class: 'lp-lower' }, content),
    centerline: content => el('div', { class: 'lp-center' }, content),
}

function groupArgument(nodes, i) {
    const attached = nodes[i].args?.filter(a => a.openMark === '{').at(-1)
    if (attached) return [attached.content, i]
    let j = i + 1
    while (nodes[j]?.type === 'whitespace') j++
    return nodes[j]?.type === 'group' ? [nodes[j].content, j] : [null, i]
}

/** \begin{list}{label}{settings}: items with the given (or per-item [optional]) label, no indentation. */
function renderList(node, ctx) {
    const defaultLabel = node.args?.[0]?.content ?? []
    const lead = []
    const items = []
    for (const child of node.content) {
        if (child.type === 'macro' && child.content === 'item') {
            const optional = child.args?.find(a => a.openMark === '[')
            const last = child.args?.at(-1)
            items.push({ label: optional ? optional.content : defaultLabel, body: last?.openMark === '' ? [...last.content] : [] })
        } else if (items.length > 0) {
            items.at(-1).body.push(child)
        } else {
            lead.push(child)
        }
    }
    return el('div', { class: 'lp-list' }, [
        ...transformMacros(lead, ctx),
        // an empty \item[] (a class's list opener, cancelled in the PDF by \vspace) prints nothing visible
        ...items
            .filter(item => printRaw(item.label).trim() || item.body.some(isVisible))
            .map(item =>
                el('div', { class: 'lp-item' }, [
                    ...(printRaw(item.label).trim()
                        ? [el('span', { class: 'lp-label' }, transformMacros(structuredClone(item.label), ctx))]
                        : []),
                    ...transformMacros(item.body, ctx),
                ]),
            ),
    ])
}

/** Tag and attributes of an element node made with htmlLike (not of its html-attr: children), or null. */
const htmlElement = node => (isHtmlLikeTag(node) ? extractFromHtmlLike(node) : null)
const isSpacer = node => htmlElement(node)?.attributes?.class === 'lp-vspace'

/** Content that shows up on the page (not spacing, comments, anchors or layout-only commands). */
function isVisible(node) {
    if (node.type === 'whitespace' || node.type === 'parbreak' || node.type === 'comment') return false
    if (isHtmlLike(node)) return !['lp-a', 'lp-vspace'].includes(String(htmlElement(node)?.attributes?.class)) // anchors, spacing
    if (node.type === 'macro' && (IGNORED.has(node.content) || node.content === '\\')) return false
    if (node.type === 'group') return node.content.some(isVisible)
    return true
}

// Line layout markers produced by transformMacros and consumed by layoutLines.
const FILL = { type: 'string', content: '' }
const BREAK = { type: 'string', content: '' }
// A paragraph break is \parskip of space: a margin, so several in a row count once (as in TeX) and a
// negative \vspace next to it collapses into their sum.
const PARBREAK = { type: 'string', content: '' }
const parSpacer = () => el('div', { class: 'lp-par' })
// a list, environment, display formula or other block ends an \hfill row
const BLOCK_TAGS = new Set(['div', 'hr', 'ul', 'ol', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'p'])
const isBlockNode = node =>
    node.type === 'environment' || node.type === 'mathenv' || node.type === 'displaymath' || BLOCK_TAGS.has(htmlElement(node)?.tag)

/**
 * `left \hfill right \\`: a line with \hfill becomes a flex row whose fills push the parts apart, as in
 * the PDF (dates flush right); other \\ become <br>.
 */
function layoutLines(nodes) {
    // TeX adds one \parskip when a paragraph starts: a break with no text since the previous one adds
    // nothing, and spacing at the very start or end of a block (or \item) is dropped
    const spacing = n => n === PARBREAK || n.type === 'whitespace' || isSpacer(n)
    let first = 0
    let last = nodes.length
    while (first < last && spacing(nodes[first])) first++
    while (last > first && spacing(nodes[last - 1])) last--
    let textSinceBreak = false
    nodes = nodes.slice(first, last).filter(n => {
        if (n !== PARBREAK) {
            if (isVisible(n)) textSinceBreak = true
            return true
        }
        const keep = textSinceBreak
        textSinceBreak = false
        return keep
    })
    if (!nodes.includes(FILL)) return nodes.map(n => (n === BREAK ? el('br', {}) : n === PARBREAK ? parSpacer() : n))
    const out = []
    let line = []
    const flush = () => {
        if (line.includes(FILL)) {
            const parts = [[]]
            for (const n of line) {
                if (n === FILL) parts.push([])
                else parts.at(-1).push(n)
            }
            out.push(
                el(
                    'div',
                    { class: 'lp-line' },
                    parts.flatMap((part, k) =>
                        k === 0 ? [el('span', {}, part)] : [el('span', { class: 'lp-fill' }), el('span', {}, part)],
                    ),
                ),
            )
        } else {
            out.push(...line)
        }
        line = []
    }
    for (const n of nodes) {
        if (n === BREAK) {
            const fillLine = line.includes(FILL)
            flush()
            if (!fillLine) out.push(el('br', {})) // a flex row already ends its line
        } else if (n === PARBREAK || isBlockNode(n)) {
            flush()
            out.push(n === PARBREAK ? parSpacer() : n)
        } else {
            line.push(n)
        }
    }
    flush()
    return out
}

function nestedInclude(node) {
    return el('span', { class: 'lp-unsupported', 'data-name': node.content, title: 'Only top-level \\input/\\include are expanded' }, [
        str(argText(lastArg(node))),
    ])
}

function references(ctx) {
    const keys = Object.keys(ctx.citeNumbers).sort((a, b) => ctx.citeNumbers[a] - ctx.citeNumbers[b])
    return el('div', { class: 'lp-references' }, [
        el('h2', { class: 'lp-heading' }, [str('References')]),
        el(
            'ol',
            {},
            keys.map(key => {
                const entry = ctx.bib[key]
                const text = entry
                    ? [entry.author, entry.title, entry.publisher ?? entry.journal ?? entry.booktitle, entry.year]
                          .filter(Boolean)
                          .join('. ') + '.'
                    : `${key} (not found in .bib)`
                return el('li', { value: String(ctx.citeNumbers[key]) }, [str(text)])
            }),
        ),
    ])
}

const isAnchorElement = n => n.type === 'element' && n.tagName === 'span' && (n.properties?.className ?? []).includes('lp-a')
const isInvisible = n =>
    (n.type === 'text' && !n.value.trim()) ||
    isAnchorElement(n) ||
    (n.type === 'element' && (n.properties?.className ?? []).includes('lp-vspace'))

/**
 * A paragraph holding only spacing (\vspace on its own) is no paragraph in TeX: unwrap it, so it adds
 * no \parskip margin (its anchors and spacers stay).
 */
function unwrapEmptyParagraphs(node) {
    if (!node.children) return
    node.children = node.children.flatMap(child =>
        child.type === 'element' && child.tagName === 'p' && child.children.every(isInvisible) ? child.children : [child],
    )
    for (const child of node.children) unwrapEmptyParagraphs(child)
}

/** Inserts the KaTeX HTML and flags unknown macros, which unified-latex-to-hast emits as span.macro. */
function finishHast(node) {
    if (node.type === 'root') unwrapEmptyParagraphs(node)
    if (node.type === 'element') {
        const props = node.properties ?? {}
        if (props.dataKatex !== undefined) {
            node.children = [{ type: 'raw', value: String(props.dataKatex) }]
            delete props.dataKatex
            return
        }
        if (node.tagName === 'a' && props.href !== undefined && !SAFE_LINK.test(String(props.href))) delete props.href
        const classes = props.className ?? []
        if (classes.includes('macro')) {
            const name = classes.find(c => c.startsWith('macro-'))?.slice(6) ?? '?'
            props.className = ['lp-unsupported']
            props.dataName = name
            props.title = `\\${name} is not rendered by the live preview`
        }
    }
    for (const child of node.children ?? []) finishHast(child)
}
