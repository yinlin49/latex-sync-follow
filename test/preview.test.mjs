import test from 'node:test'
import assert from 'node:assert'
import path from 'node:path'
import { ChunkParser, splitChunks, opensUnclosed, MAX_MERGED_PARAGRAPHS } from '../src/preview/chunks.mjs'
import { LivePreviewModel } from '../src/preview/project.mjs'
import { parseBib } from '../src/preview/bib.mjs'
import { parse } from '@unified-latex/unified-latex-util-parse'

const ROOT = path.resolve('/proj/main.tex')
const doc = body => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`

function model(files) {
    const texts = new Map(Object.entries(files).map(([name, text]) => [path.resolve('/proj', name), text]))
    const m = new LivePreviewModel({ readText: f => texts.get(path.resolve(f)), resolveImage: () => ({ src: 'img.png' }) })
    return { m, set: (name, text) => texts.set(path.resolve('/proj', name), text) }
}
const html = result => result.blocks.map(b => b.html).join('\n')
const text = result =>
    html(result)
        .replace(/<span class="katex-mathml">.*?<\/span>/gs, '')
        .replace(/<[^>]+>/g, '')

test('blank lines split paragraphs; an unclosed environment merges until it closes', () => {
    const lines = ['a', '', '\\begin{itemize}', '\\item x', '', '\\item y', '\\end{itemize}', '', 'b']
    const chunks = splitChunks(lines, 0, lines.length, new ChunkParser())
    assert.deepStrictEqual(
        chunks.map(c => [c.startLine, c.endLine]),
        [
            [0, 0],
            [2, 6],
            [8, 8],
        ],
    )
})

test('an environment left open while typing is capped instead of swallowing the file', () => {
    const lines = ['\\begin{itemize}']
    for (let i = 0; i < MAX_MERGED_PARAGRAPHS + 10; i++) lines.push('', `p${i}`)
    const chunks = splitChunks(lines, 0, lines.length, new ChunkParser())
    assert.ok(chunks.length > 1)
})

test('detects open constructs from the parser output', () => {
    for (const s of ['\\begin{x}', '{\\bf a', '$x', '\\[ x']) assert.ok(opensUnclosed(parse(s)), s)
    for (const s of ['\\begin{x}a\\end{x}', '{a}', '$x$', '\\[x\\]', 'a } b', '\\end{x}']) assert.ok(!opensUnclosed(parse(s)), s)
})

test('editing one paragraph re-parses and re-renders only that block', () => {
    const paragraphs = Array.from({ length: 50 }, (_, i) => `Paragraph ${i} with $x_${i}$.`).join('\n\n')
    const { m, set } = model({ 'main.tex': doc(paragraphs) })
    assert.strictEqual(m.update(ROOT).stats.rendered, 50)
    set('main.tex', doc(paragraphs.replace('Paragraph 20 ', 'Paragraph 20 edited ')))
    const r = m.update(ROOT)
    assert.deepStrictEqual([r.stats.parsed, r.stats.rendered], [1, 1])
    assert.match(text(r), /Paragraph 20 edited/)
})

test('inserting lines above shifts line numbers without re-rendering', () => {
    const { m, set } = model({ 'main.tex': doc('First.\n\nSecond.') })
    m.update(ROOT)
    set('main.tex', doc('\n\n\nFirst.\n\nSecond.'))
    const r = m.update(ROOT)
    assert.strictEqual(r.stats.rendered, 0)
    assert.deepStrictEqual(
        r.blocks.map(b => b.line),
        [5, 7],
    )
})

test('numbers sections, equations, floats; resolves refs, eqrefs, cites, footnotes', () => {
    const { m } = model({
        'main.tex': doc(
            [
                '\\section{Intro}\\label{s:intro}',
                'Text\\footnote{note}.',
                '',
                '\\begin{align} a&=b \\label{e:a}\\\\ c&=d \\nonumber\\\\ e&=f \\label{e:c} \\end{align}',
                '',
                '\\begin{figure}\\caption{Fig}\\label{f:x}\\end{figure}',
                '',
                '\\subsection{Sub}',
                'See \\ref{s:intro}, \\eqref{e:c}, Figure~\\ref{f:x}, \\ref{nope} \\cite{b,a} \\cite{a}.',
            ].join('\n'),
        ),
    })
    const out = text(m.update(ROOT))
    assert.match(out, /1Intro/)
    assert.match(out, /1\.1Sub/)
    assert.match(out, /Figure 1: Fig/)
    assert.match(out, /See 1, \(2\), Figure.1, \?\? \[1, 2\] \[2\]/)
    assert.match(out, /\(1\)/)
    assert.match(out, /1 note/)
})

test('inserting an equation renumbers later references', () => {
    const eq = n => `\\begin{equation} x=${n} \\label{e${n}} \\end{equation}`
    const { m, set } = model({ 'main.tex': doc(`${eq(1)}\n\nSee \\eqref{e1}.`) })
    assert.match(text(m.update(ROOT)), /See \(1\)/)
    set('main.tex', doc(`${eq(0)}\n\n${eq(1)}\n\nSee \\eqref{e1}.`))
    assert.match(text(m.update(ROOT)), /See \(2\)/)
})

test('\\input and \\include splice files in place with their own file and lines', () => {
    const { m } = model({
        'main.tex': doc('Before.\n\n\\input{sec/a}\n\nAfter.'),
        'sec/a.tex': '\\section{A}\n\nInside A.',
    })
    const r = m.update(ROOT)
    assert.deepStrictEqual(
        r.blocks.map(b => [path.basename(b.file), b.line]),
        [
            ['main.tex', 2],
            ['a.tex', 0],
            ['a.tex', 2],
            ['main.tex', 6],
        ],
    )
    assert.strictEqual(r.files.length, 2)
})

test('each source line gets an anchor carrying its line within the block', () => {
    const { m } = model({ 'main.tex': doc('Line one\nline two\n$x$ line three') })
    const anchors = [...html(m.update(ROOT)).matchAll(/data-rl="(\d+)"/g)].map(a => Number(a[1]))
    assert.deepStrictEqual(anchors, [0, 1, 2])
})

test('user macros expand; unknown macros and environments are flagged, not dropped', () => {
    const { m } = model({
        'main.tex': `\\documentclass{article}\n\\newcommand{\\R}{\\mathbb{R}}\n\\newcommand{\\hi}[1]{Hello #1}\n\\begin{document}\n\\hi{you} $x\\in\\R$ \\weird{arg}\n\n\\begin{mystery}inside\\end{mystery}\n\\end{document}`,
    })
    const out = html(m.update(ROOT))
    assert.match(out, /Hello you/)
    assert.match(out, /class="lp-unsupported" data-name="weird"/)
    assert.match(out, /class="lp-unsupported-env" data-name="mystery"/)
    assert.doesNotMatch(out, /katex-error/)
})

test('syntax errors while typing stay inside their block', () => {
    const { m } = model({ 'main.tex': doc('Good one.\n\nBroken $x^{ and \\textbf{open\n\nGood two.') })
    const r = m.update(ROOT)
    assert.match(text(r), /Good one\./)
    assert.match(text(r), /Good two\./)
})

test('maketitle, images and references render', () => {
    const { m } = model({
        'main.tex': `\\documentclass{article}\n\\title{My Title}\\author{Me}\n\\begin{document}\n\\maketitle\n\n\\includegraphics[width=0.5\\textwidth]{fig}\n\nCite \\cite{k1}.\n\n\\bibliography{refs}\n\\end{document}`,
        'refs.bib': '@article{k1, author = {A. Author}, title = {On {T}hings}, journal = "J", year = 2020}',
    })
    const out = html(m.update(ROOT))
    assert.match(out, /<h1>My Title<\/h1>/)
    assert.match(out, /<img class="lp-img" src="img.png" style="width:50%"/)
    assert.match(out, /A\. Author\. On Things\. J\. 2020\./)
})

test('tabular rows stay separate (\\\\ is a row break there, a line break elsewhere)', () => {
    const { m } = model({
        'main.tex': doc('\\begin{tabular}{lr}\\toprule\nName & Value \\\\\n\\midrule\nG & 42 \\\\\n\\bottomrule\n\\end{tabular}\n\nA\\\\B'),
    })
    const out = html(m.update(ROOT))
    assert.match(out, /<td>[^]*?G\s*<\/td><td[^>]*>\s*42/)
    assert.strictEqual((out.match(/<tr>/g) ?? []).length >= 2, true)
    assert.match(out, /A<br>/)
})

test('a pending image re-renders its block once found', () => {
    let image = { pending: true }
    const texts = new Map([[ROOT, doc('\\includegraphics{fig}\n\nOther.')]])
    const m = new LivePreviewModel({ readText: f => texts.get(path.resolve(f)), resolveImage: () => image })
    assert.match(html(m.update(ROOT)), /loading image: fig/)
    image = { src: 'found.png' }
    const r = m.update(ROOT)
    assert.strictEqual(r.stats.rendered, 1)
    assert.match(html(r), /src="found.png"/)
})

test('font declarations style the rest of their group', () => {
    const { m } = model({ 'main.tex': doc('a {\\bf bold {\\em both}} plain \\it rest') })
    const out = html(m.update(ROOT))
    assert.match(out, /<span class="lp-bf">bold <span class="lp-em">both<\/span><\/span>/)
    assert.match(out, /plain <span class="lp-it">rest<\/span>/)
    assert.doesNotMatch(out, /lp-unsupported/)
})

test('an unknown list-like environment keeps its title and items', () => {
    const { m } = model({ 'main.tex': doc('\\begin{rSection}{Education}\n\\item First\n\\item Second\n\\end{rSection}') })
    const out = html(m.update(ROOT))
    assert.match(out, /lp-unsupported-env" data-name="rSection"/)
    assert.match(out, /<div class="lp-env-title">Education<\/div>/)
    assert.match(out, /<li>[^]*First[^]*<\/li>[^]*<li>[^]*Second/)
})

test('definition bodies do not count; macro-made sections and footnotes do', () => {
    const { m } = model({
        'main.tex': `\\documentclass{article}\n\\newcommand{\\fn}[1]{\\footnote{#1}}\n\\newcommand{\\me}{\\cite{zzz}}\n\\newcommand{\\sec}[1]{\\section{#1}}\n\\begin{document}\n\\sec{X}\n\n\\sec{Y} real\\fn{one} \\cite{a}\n\\end{document}`,
    })
    const out = text(m.update(ROOT))
    assert.match(out, /1X/)
    assert.match(out, /2Y/)
    assert.match(out, /real1/)
    assert.match(out, /\[1\]/)
})

test('a ref inside math follows renumbering', () => {
    const eq = n => `\\begin{equation} x=${n} \\label{e${n}} \\end{equation}`
    const { m, set } = model({ 'main.tex': doc(`${eq(1)}\n\nsee $y=\\eqref{e1}$`) })
    m.update(ROOT)
    set('main.tex', doc(`${eq(0)}\n\n${eq(1)}\n\nsee $y=\\eqref{e1}$`))
    assert.match(text(m.update(ROOT)), /y=\(2\)/)
})

test('\\tag{A} numbers the equation and its references', () => {
    const { m } = model({ 'main.tex': doc('\\begin{equation} x \\tag{A} \\label{k} \\end{equation}\n\nSee \\eqref{k}.') })
    const out = text(m.update(ROOT))
    assert.match(out, /\(A\)/)
    assert.match(out, /See \(A\)/)
    assert.doesNotMatch(out, /xA/)
})

test('a file input twice renders twice; preamble \\input supplies macros', () => {
    const { m } = model({
        'main.tex': '\\documentclass{article}\n\\input{mac}\n\\begin{document}\n\\input{a}\n\n\\input{a}\n\\end{document}',
        'mac.tex': '\\newcommand{\\foo}{FOO}',
        'a.tex': 'Text \\foo.',
    })
    const r = m.update(ROOT)
    assert.strictEqual((text(r).match(/Text FOO/g) ?? []).length, 2)
    assert.ok(r.files.some(f => f.endsWith('mac.tex')))
})

test('user text cannot hit object prototype keys; unsafe links lose their href', () => {
    const { m } = model({
        'main.tex': doc('\\cite{constructor} \\ref{toString} \\href{javascript:alert(1)}{bad} \\href{https://ok.example}{good}'),
    })
    const out = html(m.update(ROOT))
    assert.match(out, /\[1\]/)
    assert.match(out, /\?\?/)
    assert.doesNotMatch(out, /javascript:/)
    assert.match(out, /href="https:\/\/ok\.example"/)
})

test('a local class: \\newenvironment wrapping a list, parameterless \\def, page from options + geometry', () => {
    const { m } = model({
        'main.tex':
            '\\documentclass{cv}\n\\usepackage[left=0.5in,right=0.5in,top=0.4in]{geometry}\n\\begin{document}\n' +
            '\\begin{sec}{Education}\n\\item[]\n\\vspace{-1em}\n\n\\item {\\bf Degree} \\hfill {2020 -- 2024} \\\\\nGPA \\& more \\hfill {\\em City}\n\\begin{itemize}\\item first\\end{itemize}\n\\end{sec}\n\\end{document}',
        'cv.cls':
            '\\LoadClass[11pt,a4paper]{article}\n\\def\\gap{\\medskip}\n' +
            '\\newenvironment{sec}[1]{\\gap\\MakeUppercase{{\\bf #1}}\\hrule\\begin{list}{}{\\setlength{\\leftmargin}{0em}}}{\\end{list}}',
    })
    const r = m.update(ROOT)
    const out = html(r)
    assert.deepStrictEqual(r.page, { width: 595.3, left: 36, right: 36, top: 28.8, fontPt: 11 })
    assert.ok(r.files.some(f => f.endsWith('cv.cls')))
    assert.match(out, /<span class="lp-upper"><span class="lp-bf">Education<\/span><\/span>/)
    assert.match(out, /<hr class="lp-hrule">/)
    assert.strictEqual((out.match(/class="lp-item"/g) ?? []).length, 1) // the empty \item[] prints nothing
    assert.match(out, /<div class="lp-line">[^]*Degree[^]*class="lp-fill"[^]*2020 – 2024/)
    assert.match(out, /GPA &#x26; more|GPA &amp; more/)
    assert.doesNotMatch(out, /lp-unsupported/)
    // the itemize below the \hfill row is not squeezed into it
    assert.match(out, /City<\/span>(?:(?!lp-line)[^])*?<\/div><ul class="itemize">/)
})

test('paragraph breaks count once; \\vspace and length assignments print nothing', () => {
    // inside one environment (one block), so the breaks are within the block
    const { m } = model({
        'main.tex': doc(
            '\\begin{center}\\begin{itemize}\\itemsep -3pt {}\\item a\\end{itemize}\nOne.\n\n\\vspace{0.4em}\n\nTwo.\\end{center}',
        ),
    })
    const out = html(m.update(ROOT))
    assert.doesNotMatch(out, /-3pt/)
    assert.strictEqual((out.match(/class="lp-par"/g) ?? []).length, 1)
    assert.match(out, /lp-vspace" style="height:0.4em"/)
})

test('resume.cls prints \\name and \\address lines at the top', () => {
    const { m } = model({
        'main.tex':
            '\\documentclass{resume}\n\\name{Jane Doe}\n\\address{City \\\\ Country}\n\\address{mail}\n\\address{Title}\n\\begin{document}\nBody.\n\\end{document}',
    })
    const out = text(m.update(ROOT))
    assert.match(out, /^Jane DoeTitleCity\s*⋄?\s*Country/)
})

test('parseBib reads braces, quotes, bare values and nested braces', () => {
    const bib = parseBib('@book{k, title = {The {\\TeX}book}, year = 1984, note = "a {b} c"}\n@comment{x}\n@misc{m,author={X}}')
    assert.deepStrictEqual(bib.k, { title: 'The \\TeXbook', year: '1984', note: 'a b c' })
    assert.deepStrictEqual(bib.m, { author: 'X' })
})
