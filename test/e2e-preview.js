'use strict'
// End-to-end check of the Live Preview tab in a real VS Code window, with typing-latency measurement.
// Usage: node test/e2e-preview.js   (env E2E_DIR overrides the scratch directory)
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const {
    WORK, PROJECT, sleep, check, lineOf, waitFor, prepare, launch,
    runCommand, openFile, cursorLine, gotoLine, clickLine, saveAll, summary,
} = require('./driver')

const LONG_SECTIONS = 300

function longDocument() {
    let s = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n'
    for (let i = 0; i < LONG_SECTIONS; i++) {
        s += `\\section{Part ${i}}\nSome text with $a_{${i}}^2+\\frac{x}{y}$ and more words here to fill the line nicely.\n`
        s += `Another line \\textbf{bold} \\emph{em} and a reference to \\eqref{eq:${i}}.\n\n`
        s += `\\begin{equation}\\int_0^1 f(x)\\,dx = \\sum_{k=0}^{n} k^{${i}} \\label{eq:${i}}\\end{equation}\n`
        s += '\\begin{itemize}\\item one\\item two\\end{itemize}\n\n'
    }
    return `${s}LONGEND marker.\n\\end{document}\n`
}

const stats = values => {
    const v = [...values].sort((a, b) => a - b)
    const at = p => v[Math.min(v.length - 1, Math.floor(p / 100 * v.length))]
    return { n: v.length, p50: at(50), p95: at(95), p99: at(99), max: v[v.length - 1] }
}
const fmt = s => `n=${s.n} p50=${s.p50}ms p95=${s.p95}ms p99=${s.p99}ms max=${s.max}ms`

async function previewFrame(win) {
    return waitFor(async () => {
        for (const frame of win.frames()) {
            const ok = await frame.evaluate(() => Boolean(document.getElementById('doc')?.querySelector('.lp-block'))).catch(() => false)
            if (ok) return frame
        }
        return undefined
    }, 30000, 'live preview frame')
}

// textContent, not innerText: off-screen blocks are skipped by content-visibility and innerText omits them
const previewText = frame => frame.evaluate(() => [...document.getElementById('doc').children].map(b => b.textContent).join('\n'))

/** Records, in the webview, the time and text of every block element the preview inserts. */
async function recordBlocks(frame) {
    await frame.evaluate(() => {
        window.__inserted = []
        if (window.__blockObserver) return
        window.__blockObserver = new MutationObserver(records => {
            const at = Date.now()
            for (const r of records) for (const n of r.addedNodes) {
                if (n.classList?.contains('lp-block')) window.__inserted.push({ at, text: n.textContent })
            }
        })
        window.__blockObserver.observe(document.getElementById('doc'), { childList: true })
    })
}

/** Records, in the workbench, when the editor's visible text changes (the editor's own echo). */
async function recordEditor(win) {
    await win.evaluate(() => {
        window.__echo = []
        window.__echoObserver?.disconnect()
        const lines = document.querySelector('.monaco-editor.focused .view-lines')
        window.__echoObserver = new MutationObserver(() => window.__echo.push({ at: Date.now(), text: lines.textContent }))
        window.__echoObserver.observe(lines, { childList: true, subtree: true, characterData: true })
    })
}

/**
 * Types `chars` one key at a time after a unique `tag`, then matches each keystroke with the first
 * preview block (and editor frame) showing the text up to that key. Returns per-key latencies.
 */
async function typeMeasured(win, frame, tag, chars, gapMs) {
    if (frame) await recordBlocks(frame)
    await recordEditor(win)
    await win.keyboard.type(` ${tag}`)
    await sleep(400)
    if (frame) await frame.evaluate(() => { window.__inserted = [] })
    await win.evaluate(() => { window.__echo = [] })
    const pressedAt = []
    for (const ch of chars) {
        pressedAt.push(Date.now())
        await win.keyboard.press(ch)
        if (gapMs) await sleep(gapMs)
    }
    await sleep(1500)
    const echo = await win.evaluate(() => window.__echo)
    const inserted = frame ? await frame.evaluate(() => window.__inserted) : []
    const preview = []
    const editor = []
    for (let i = 0; i < chars.length; i++) {
        const expected = tag + chars.slice(0, i + 1)
        const p = inserted.find(r => r.at >= pressedAt[i] - 5 && r.text.includes(expected))
        const e = echo.find(r => r.at >= pressedAt[i] - 5 && r.text.includes(expected))
        if (p) preview.push(p.at - pressedAt[i])
        if (e) editor.push(e.at - pressedAt[i])
    }
    return { preview, editor, missing: frame ? chars.length - preview.length : 0 }
}

function randomWord(n) {
    return Array.from({ length: n }, (_, i) => 'abcdefghijklmnopqrstuvwxyz'[(i * 7 + 3) % 26]).join('')
}

/** Working set (MB) and CPU seconds of all processes of the test VS Code instance. */
function vscodeProcesses() {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(WORK)}*' } | ` +
        'ForEach-Object { "$($_.WorkingSetSize) $($_.KernelModeTime + $_.UserModeTime) $($_.ProcessId) $($_.CommandLine -match \'--type=renderer\') $($_.CommandLine -match \'node.mojom.NodeService\')" }'],
    { encoding: 'utf8' })
    let mb = 0
    let cpu = 0
    const byProcess = {}
    for (const line of ps.stdout.split(/\r?\n/).filter(Boolean)) {
        const [ws, t, pid, renderer, node] = line.split(' ')
        mb += Number(ws) / 1048576
        cpu += Number(t) / 1e7
        byProcess[pid] = { kind: renderer === 'True' ? 'renderer' : node === 'True' ? 'node' : 'other', cpu: Number(t) / 1e7 }
    }
    return { mb: Math.round(mb), cpuSec: Math.round(cpu * 10) / 10, byProcess }
}

/** CPU seconds spent per process between two vscodeProcesses() samples, largest first. */
function cpuDelta(before, after) {
    return Object.entries(after.byProcess)
        .map(([pid, p]) => ({ pid, kind: p.kind, sec: Math.round((p.cpu - (before.byProcess[pid]?.cpu ?? 0)) * 10) / 10 }))
        .filter(p => p.sec >= 0.2).sort((a, b) => b.sec - a.sec)
}

function extensionStats() {
    const logs = path.join(WORK, 'user-data', 'logs')
    const session = fs.readdirSync(logs).sort().pop()
    const file = path.join(logs, session, 'window1', 'exthost', 'local.latex-sync-follow', 'LaTeX SyncTeX Follow.log')
    const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.includes('live preview stats')).pop()
    return JSON.parse(line.slice(line.indexOf('{')))
}

async function clickPreviewText(frame, marker) {
    const box = await frame.evaluate(async m => {
        const walker = document.createTreeWalker(document.getElementById('doc'), NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const at = node.textContent.indexOf(m)
            if (at < 0) continue
            const range = document.createRange()
            range.setStart(node, at)
            range.setEnd(node, at + m.length)
            // scroll twice: blocks that were off-screen get their real layout only after a frame
            for (let i = 0; i < 2; i++) {
                range.startContainer.parentElement.scrollIntoView({ block: 'center' })
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            }
            const r = range.getBoundingClientRect()
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
        }
        return null
    }, marker)
    if (!box) throw new Error(`${marker} not in preview`)
    await frame.locator('#doc').click({ position: await frame.evaluate(({ x, y }) => {
        const d = document.getElementById('doc').getBoundingClientRect()
        return { x: x - d.left, y: y - d.top }
    }, box) })
}

async function expectJump(win, relFile, line, name) {
    await waitFor(async () => (await win.title()).includes(path.basename(relFile)) && (await cursorLine(win)) === line,
        5000, name).then(() => check(name, true, `${relFile}:${line}`),
        async () => check(name, false, `got ${await win.title()} Ln ${await cursorLine(win)}, want ${relFile}:${line}`))
}

async function highlightState(frame) {
    return frame.evaluate(() => {
        const range = CSS.highlights.get('lp-line') && [...CSS.highlights.get('lp-line')][0]
        const r = range?.getBoundingClientRect()
        return {
            text: range?.toString() ?? '',
            visible: Boolean(r && r.bottom > 0 && r.top < window.innerHeight),
            block: document.querySelector('.lp-current')?.textContent.slice(0, 80) ?? '',
        }
    })
}

// ---------------------------------------------------------------------------------------------

async function testOpenAndRender(win) {
    await openFile(win, 'main.tex')
    const before = vscodeProcesses()
    const started = Date.now()
    await runCommand(win, 'LaTeX: Open Live Preview')
    const frame = await previewFrame(win)
    await waitFor(async () => (await previewText(frame)).includes('OMEGAEND'), 10000, 'full render')
    check('preview tab opens and renders the project', true, `${Date.now() - started} ms to first full render`)
    // the TeX-tree image arrives asynchronously after the first render
    await waitFor(async () => frame.evaluate(() => document.querySelector('img.lp-img')?.naturalWidth > 0), 15000, 'image')
        .catch(() => undefined)
    const text = await previewText(frame)
    check('multi-file content (\\input, \\include) in preview',
        ['ALPHAONE', 'ALPHATWO', 'BETAONE', 'BETATWO', 'GAMMAROW', 'OMEGAEND'].every(m => text.includes(m)))
    check('numbered sections, equation, captions, citation, references',
        /1\s*Introduction/.test(text) && /2\s*Results/.test(text) && text.includes('Table 1: Table with marker TABLECAP')
        && text.includes('Figure 1: Figure with marker FIGCAP') && text.includes('[1]') && text.includes('Knuth')
        && /\(1\)/.test(text))
    const visuals = await frame.evaluate(() => ({
        katex: document.querySelectorAll('.katex').length,
        image: [...document.querySelectorAll('img.lp-img')].map(i => i.naturalWidth),
        table: document.querySelectorAll('table.tabular td').length,
        unsupported: [...document.querySelectorAll('.lp-unsupported')].map(e => e.dataset.name),
    }))
    check('math rendered by KaTeX, image loaded, table rendered',
        visuals.katex >= 1 && visuals.image.length === 1 && visuals.image[0] > 0 && visuals.table >= 4, JSON.stringify(visuals))
    check('no PDF is built while previewing', !fs.existsSync(path.join(PROJECT, 'main.pdf')) && !fs.existsSync(path.join(PROJECT, 'main.log')))
    console.log(`      note: VS Code instance before preview ${JSON.stringify(before)}`)
}

async function testTypingLatency(win, results) {
    const frame = await previewFrame(win)
    await openFile(win, 'sections/intro.tex')
    await gotoLine(win, lineOf('sections/intro.tex', 'ALPHAONE'))
    await win.keyboard.press('End')
    const human = await typeMeasured(win, frame, 'LATA', randomWord(60), 90)
    const fast = await typeMeasured(win, frame, 'LATB', randomWord(80), 15)
    results.small = { human, fast }
    const final = await previewText(frame)
    check('typing ~11 keys/s: every keystroke reaches the preview', human.missing === 0, `preview ${fmt(stats(human.preview))}`)
    check('typing ~40+ keys/s: newest text wins, nothing lost', fast.missing === 0 && final.includes(`LATB${randomWord(80)}`),
        `preview ${fmt(stats(fast.preview))}`)
    console.log(`      editor echo with preview open: ${fmt(stats([...human.editor, ...fast.editor]))}`)
}

async function testEditorBaseline(win, results) {
    // same typing with the preview hidden behind another tab in its group: the editor's own echo latency
    await openFile(win, 'sections/results.tex')
    await gotoLine(win, lineOf('sections/results.tex', 'BETATWO'))
    await win.keyboard.press('End')
    const closed = await typeMeasured(win, null, 'LATC', randomWord(60), 90)
    results.editorWithoutPreview = closed.editor
    console.log(`      editor echo, preview not updating: ${fmt(stats(closed.editor))}`)
}

async function testEdits(win) {
    const frame = await previewFrame(win)
    await openFile(win, 'sections/results.tex')
    // paste a multi-line block
    await gotoLine(win, lineOf('sections/results.tex', 'BETAONE'))
    await win.keyboard.press('End')
    const pasted = '\n\nPasted paragraph PASTEONE with $\\sum_{i=1}^{n} i$ here\nand a second line PASTETWO.\n\n\\begin{itemize}\n\\item PASTEITEM one\n\\item two\n\\end{itemize}\n'
    let t = Date.now()
    await win.keyboard.insertText(pasted)
    await waitFor(async () => /PASTEONE[\s\S]*PASTETWO[\s\S]*PASTEITEM/.test(await previewText(frame)), 5000, 'paste')
        .then(() => check('paste multi-line block (paragraph, math, list)', true, `${Date.now() - t} ms incl. polling`),
            () => check('paste multi-line block (paragraph, math, list)', false))
    // select the pasted lines and delete them in one edit
    await saveAll(win)
    await gotoLine(win, lineOf('sections/results.tex', 'PASTEONE'))
    for (let i = lineOf('sections/results.tex', 'PASTEONE'); i <= lineOf('sections/results.tex', '\\item two') + 1; i++) {
        await win.keyboard.press('Shift+ArrowDown')
    }
    t = Date.now()
    await win.keyboard.press('Delete')
    await waitFor(async () => !/PASTEONE|PASTEITEM/.test(await previewText(frame)), 5000, 'delete')
        .then(() => check('delete several lines at once', true, `${Date.now() - t} ms incl. polling`),
            () => check('delete several lines at once', false))
    await saveAll(win)

    // table cell, heading, list, image width
    await gotoLine(win, lineOf('sections/results.tex', 'GAMMAROW'))
    await win.keyboard.press('Home')
    await win.keyboard.type('NEWCELL')
    await waitFor(async () => (await previewText(frame)).includes('NEWCELLGAMMAROW'), 5000, 'table')
        .then(() => check('edit table cell', true), () => check('edit table cell', false))
    await gotoLine(win, lineOf('sections/results.tex', '\\section{Results}'))
    await win.keyboard.press('End')
    await win.keyboard.press('ArrowLeft')
    await win.keyboard.type(' Renamed')
    await waitFor(async () => /2\s*Results Renamed/.test(await previewText(frame)), 5000, 'heading')
        .then(() => check('edit heading (number kept)', true), () => check('edit heading (number kept)', false))
    await saveAll(win)
    await gotoLine(win, lineOf('sections/results.tex', 'width=0.4'))
    await win.keyboard.press('End')
    await win.keyboard.press('Home')
    await win.keyboard.press('Shift+End')
    await win.keyboard.insertText('\\includegraphics[width=0.8\\textwidth]{example-image-a}')
    await waitFor(async () => frame.evaluate(() => document.querySelector('img.lp-img')?.style.width === '80%'), 5000, 'image')
        .then(() => check('edit image width', true), () => check('edit image width', false))

    // math
    await saveAll(win)
    await openFile(win, 'sections/intro.tex')
    await gotoLine(win, lineOf('sections/intro.tex', 'E = mc^2'))
    await win.keyboard.press('End')
    await win.keyboard.type(' + \\alpha_{k}')
    await waitFor(async () => frame.evaluate(() => [...document.querySelectorAll('.lp-math-d')]
        .some(e => e.textContent.includes('α') && e.textContent.includes('(1)'))), 5000, 'math')
        .then(() => check('edit display equation (KaTeX, number kept)', true), () => check('edit display equation (KaTeX, number kept)', false))

    // transient syntax errors while typing
    await gotoLine(win, lineOf('sections/intro.tex', 'ALPHATWO'))
    await win.keyboard.press('End')
    await win.keyboard.type(' \\textbf{UNCLOSED $x^{')
    await sleep(500)
    const broken = await previewText(frame)
    check('unfinished \\textbf{ and $ only affect their own paragraph',
        broken.includes('OMEGAEND') && broken.includes('ALPHATHREE') && broken.includes('BETATWO'))
    await win.keyboard.type('2}$ done}')
    await waitFor(async () => frame.evaluate(() => [...document.querySelectorAll('b, strong')]
        .some(e => e.textContent.includes('UNCLOSED'))), 5000, 'fixed').then(() => check('closing it renders bold + math', true),
        () => check('closing it renders bold + math', false))
    await saveAll(win)
    await gotoLine(win, lineOf('sections/intro.tex', 'ALPHAONE'))
    await win.keyboard.press('End')
    // insertText: LaTeX Workshop's Enter key handler would add \item lines of its own
    await win.keyboard.insertText('\n\n\\begin{itemize}\n\\item OPENLIST')
    await sleep(600)
    const open = await previewText(frame)
    check('an unclosed \\begin{itemize} keeps the rest of the document visible',
        open.includes('OPENLIST') && open.includes('OMEGAEND') && open.includes('ALPHATWO'))
    await win.keyboard.insertText('\n\\end{itemize}')
    await waitFor(async () => frame.evaluate(() => [...document.querySelectorAll('li')].some(li => li.textContent.includes('OPENLIST'))),
        5000, 'list').then(() => check('closing it renders a list item', true), () => check('closing it renders a list item', false))
}

async function testSourceToPreview(win) {
    await saveAll(win)
    const frame = await previewFrame(win)
    await openFile(win, 'sections/results.tex')
    await frame.evaluate(() => window.scrollTo(0, 0))
    await clickLine(win, lineOf('sections/results.tex', 'BETATWO'))
    await sleep(300)
    let h = await highlightState(frame)
    check('click source line -> preview scrolls and highlights it', h.visible && h.text.includes('BETATWO'), JSON.stringify(h))
    await clickLine(win, lineOf('sections/results.tex', 'FIGCAP'))
    await sleep(300)
    h = await highlightState(frame)
    check('click caption line -> figure caption highlighted', h.visible && h.text.includes('FIGCAP'), JSON.stringify(h.text))
    await win.keyboard.press('ArrowUp')
    await win.keyboard.press('ArrowUp')
    await sleep(300)
    h = await highlightState(frame)
    check('arrow keys move the preview highlight', h.visible && h.text.includes('example-image-a') === false && h.block.length > 0, JSON.stringify(h))
    await openFile(win, 'main.tex')
    await clickLine(win, lineOf('main.tex', 'OMEGAEND'))
    await sleep(300)
    h = await highlightState(frame)
    check('root file line -> preview highlight', h.visible && h.text.includes('OMEGAEND'), JSON.stringify(h.text))
}

async function testPreviewToSource(win) {
    await saveAll(win)
    const frame = await previewFrame(win)
    for (const zoom of ['100%', '150%', '70%']) {
        while (await frame.evaluate(() => document.getElementById('zoom').textContent) !== zoom) {
            const target = Number(zoom.replace('%', ''))
            const current = Number((await frame.evaluate(() => document.getElementById('zoom').textContent)).replace('%', ''))
            await frame.click(current < target ? '#zoom-in' : '#zoom-out')
        }
        for (const [marker, file] of [['FIGCAP', 'sections/results.tex'], ['OMEGAEND', 'main.tex'], ['ALPHATHREE', 'sections/intro.tex'],
            ['GAMMAROW', 'sections/results.tex']]) {
            await clickPreviewText(frame, marker)
            await expectJump(win, file, lineOf(file, marker), `zoom ${zoom}: click preview "${marker}" -> source line`)
        }
    }
    // a word on the second source line of a multi-line paragraph maps to that line, not the paragraph start
    await openFile(win, 'sections/intro.tex')
    await gotoLine(win, lineOf('sections/intro.tex', 'ALPHATHREE'))
    await win.keyboard.press('End')
    // insertText: LaTeX Workshop handles Enter asynchronously, so fast typed keys can overtake it
    await win.keyboard.insertText('\nSECONDLINE continues the same paragraph.')
    await waitFor(async () => (await previewText(frame)).includes('SECONDLINE'), 5000, 'second line')
    await saveAll(win)
    await clickPreviewText(frame, 'SECONDLINE')
    await expectJump(win, 'sections/intro.tex', lineOf('sections/intro.tex', 'SECONDLINE'), 'click second line of a paragraph -> that line')
    const equation = frame.locator('.lp-math-d .katex').first()
    await equation.scrollIntoViewIfNeeded()
    await equation.click()
    await expectJump(win, 'sections/intro.tex', lineOf('sections/intro.tex', '\\begin{equation}'),
        'click on a display equation -> its \\begin{equation} line')
}

async function testCpuBaseline(win, results) {
    // the same typing in the long document with the preview closed: what VS Code itself costs
    await win.keyboard.press('Control+2')
    await sleep(300)
    await win.keyboard.press('Control+W')
    await sleep(500)
    await openFile(win, 'long.tex')
    await gotoLine(win, lineOf('long.tex', 'Part 100}') + 1)
    await win.keyboard.press('End')
    const before = vscodeProcesses()
    await typeMeasured(win, null, 'LATE', randomWord(120), 30)
    const after = vscodeProcesses()
    results.cpuBaseline = after.cpuSec - before.cpuSec
    console.log(`      CPU during 120 keys, preview closed: ${(after.cpuSec - before.cpuSec).toFixed(1)} s; RAM ${after.mb} MB`)
    console.log(`      per process: ${JSON.stringify(cpuDelta(before, after))}`)
}

async function testLongDocument(win, results) {
    await openFile(win, 'long.tex')
    const started = Date.now()
    const frame = await previewFrame(win)
    await waitFor(async () => (await previewText(frame)).includes('LONGEND'), 30000, 'long render')
    check(`long document (${LONG_SECTIONS} sections, ${LONG_SECTIONS} equations, ~2100 lines) renders`, true,
        `${Date.now() - started} ms after switching file`)
    await clickLine(win, lineOf('long.tex', 'Part 150}') + 1)
    await sleep(500)
    const scrollBefore = await frame.evaluate(() => window.scrollY)
    await win.keyboard.press('End')
    const before = vscodeProcesses()
    const typing = await typeMeasured(win, frame, 'LATD', randomWord(120), 30)
    const after = vscodeProcesses()
    const scrollAfter = await frame.evaluate(() => window.scrollY)
    results.long = typing
    results.cpuWithPreview = after.cpuSec - before.cpuSec
    check('long document: every keystroke reaches the preview', typing.missing === 0, `preview ${fmt(stats(typing.preview))}`)
    check('long document: scroll position kept while typing', Math.abs(scrollAfter - scrollBefore) < 40, `${scrollBefore} -> ${scrollAfter}`)
    console.log(`      CPU during 120 keys: ${(after.cpuSec - before.cpuSec).toFixed(1)} s over ${(120 * 0.03 + 1.9).toFixed(1)} s; RAM ${before.mb} -> ${after.mb} MB`)
    console.log(`      per process: ${JSON.stringify(cpuDelta(before, after))}`)
}

async function testMemory(win, results) {
    const frame = await previewFrame(win)
    const rounds = []
    for (let round = 0; round < 3; round++) {
        await typeMeasured(win, frame, `MEM${round}X`, randomWord(150), 10)
        await sleep(1000)
        const webview = await frame.evaluate(() => ({ heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
            nodes: document.getElementsByTagName('*').length }))
        rounds.push({ ...webview, processesMB: vscodeProcesses().mb })
    }
    results.memory = rounds
    const grow = rounds[2].processesMB - rounds[0].processesMB
    check('no steady memory growth over 3 × 150 keystrokes', grow < 150 && Math.abs(rounds[2].nodes - rounds[0].nodes) < 200,
        JSON.stringify(rounds))
}

async function testExport(win) {
    await openFile(win, 'main.tex')
    const frame = await previewFrame(win)
    const started = Date.now()
    await frame.click('#export')
    const note = win.locator('.notification-toast', { hasText: 'Exported main.pdf' })
    await note.waitFor({ timeout: 120000 }).then(() => check('Export PDF button builds with LaTeX', true, `${Date.now() - started} ms`),
        () => check('Export PDF button builds with LaTeX', false))
    const pdf = path.join(PROJECT, 'main.pdf')
    const pdfText = spawnSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' }).stdout ?? ''
    const preview = await previewText(frame)
    const markers = ['ALPHAONE', 'ALPHATWO', 'ALPHATHREE', 'BETAONE', 'BETATWO', 'NEWCELLGAMMAROW', 'FIGCAP', 'TABLECAP', 'OMEGAEND',
        'SECONDLINE', 'Results Renamed', 'Knuth']
    const missing = markers.filter(m => !pdfText.includes(m) || !preview.includes(m))
    check('exported PDF and preview contain the same edited content', missing.length === 0, missing.join(', '))
    const numbers = ['Table 1:', 'Figure 1:', '(1)', '[1]'].filter(m => !(pdfText.includes(m) && preview.includes(m)))
    check('numbering matches the PDF (table, figure, equation, citation)', numbers.length === 0, numbers.join(', '))
    const hasOpen = await note.locator('a, .monaco-button', { hasText: 'Open PDF' }).count()
    check('export notification offers Open PDF / Save As', hasOpen > 0)
}

async function main() {
    prepare({}, { 'long.tex': longDocument() })
    const { app, win } = await launch()
    const results = {}
    try {
        const only = process.env.E2E_ONLY?.split(',')
        const steps = [testOpenAndRender, testTypingLatency, testEditorBaseline, testEdits, testSourceToPreview,
            testPreviewToSource, testLongDocument, testMemory, testExport, testCpuBaseline]
        for (const step of steps.filter(s => s === testOpenAndRender || !only || only.includes(s.name))) {
            try {
                await step(win, results)
            } catch (e) {
                check(`${step.name} crashed`, false, e.message.split('\n')[0])
                await win.screenshot({ path: path.join(WORK, `${step.name}.png`) }).catch(() => undefined)
            }
        }
        await runCommand(win, 'LaTeX: Show Live Preview Latency Stats')
        await sleep(1000)
        results.extension = extensionStats()
        const all = [...(results.small?.human.preview ?? []), ...(results.small?.fast.preview ?? [])]
        console.log('\n=== typing -> preview latency (keystroke sent by Playwright -> preview block in DOM) ===')
        if (results.small) {
            console.log(`small doc, 11 keys/s: ${fmt(stats(results.small.human.preview))}`)
            console.log(`small doc, burst:     ${fmt(stats(results.small.fast.preview))}`)
            console.log(`small doc, all:       ${fmt(stats(all))}`)
        }
        if (results.long) console.log(`long doc (2100 lines): ${fmt(stats(results.long.preview))}`)
        console.log(`extension (edit received -> painted, double rAF): ${JSON.stringify(results.extension)}`)
        fs.writeFileSync(path.join(WORK, 'preview-latency.json'), JSON.stringify(results, null, 1))
    } finally {
        await app.close()
    }
    summary()
}

main().catch(e => {
    console.error(e)
    process.exitCode = 1
})
