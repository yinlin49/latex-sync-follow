'use strict'
// End-to-end check in a real VS Code window (Playwright drives Electron): LaTeX Workshop builds,
// the real PDF tab viewer, real mouse/keyboard input, and this extension's cursor follow.
// Usage: node test/e2e.js   (env E2E_DIR overrides the scratch directory)
const fs = require('fs')
const path = require('path')
const {
    WORK, PROJECT, sleep, check, lineOf, md5, waitFor, prepare, launch,
    runCommand, openFile, cursorLine, gotoLine, clickLine, summary,
} = require('./driver')

const BUILD_TIMEOUT = 60000
// This suite exercises the PDF + SyncTeX loop, so it turns live PDF building back on.
const AUTO_BUILD = {
    'files.autoSave': 'afterDelay',
    'files.autoSaveDelay': 800,
    'latex-workshop.latex.autoBuild.run': 'onFileChange',
}

async function syncStatus(win) {
    return win.locator('.statusbar-item', { hasText: 'SyncTeX' }).first().innerText().catch(() => '')
}

async function viewerFrame(win) {
    return waitFor(async () => {
        const frame = win.frames().find(f => f.url().includes('viewer.html'))
        if (!frame) return undefined
        const ready = await frame.evaluate(() => Boolean(window.PDFViewerApplication?.pdfDocument
            && document.querySelector('.textLayer span')))
        return ready ? frame : undefined
    }, 60000, 'PDF viewer frame')
}

/** Records every SyncTeX indicator box the viewer draws (they fade out and are removed). */
async function recordIndicators(frame) {
    await frame.evaluate(() => {
        if (window.__indicators) return
        window.__indicators = []
        const container = document.getElementById('viewerContainer')
        new MutationObserver(mutations => {
            for (const m of mutations) for (const node of m.addedNodes) {
                if (!node.classList?.contains('synctex-indicator-rect')) continue
                const r = node.getBoundingClientRect()
                const c = container.getBoundingClientRect()
                window.__indicators.push({
                    at: Date.now(),
                    top: r.top + container.scrollTop,
                    bottom: r.bottom + container.scrollTop,
                    visible: r.top >= c.top - 1 && r.bottom <= c.bottom + 1,
                })
            }
        }).observe(document.body, { childList: true, subtree: true })
        window.__textUnder = index => {
            const box = window.__indicators[index]
            const scroll = container.scrollTop
            return [...document.querySelectorAll('.textLayer span')].filter(span => {
                const q = span.getBoundingClientRect()
                return q.bottom + scroll > box.top + 1 && q.top + scroll < box.bottom - 1
            }).map(span => span.textContent).join(' ')
        }
    })
}

const indicatorCount = frame => frame.evaluate(() => window.__indicators.length)

async function nextIndicator(frame, before, timeout = 5000) {
    await frame.waitForFunction(n => window.__indicators.length > n, before, { timeout })
    await sleep(700) // let pdf.js render the text layer of the page scrolled into view
    const index = (await indicatorCount(frame)) - 1
    const info = await frame.evaluate(i => window.__indicators[i], index)
    return { ...info, text: await frame.evaluate(i => window.__textUnder(i), index) }
}

async function pdfText(frame) {
    return frame.evaluate(async () => {
        const doc = window.PDFViewerApplication.pdfDocument
        let text = ''
        for (let i = 1; i <= doc.numPages; i++) {
            const content = await (await doc.getPage(i)).getTextContent()
            text += content.items.map(item => item.str).join(' ') + '\n'
        }
        return text
    })
}

async function waitForPdfText(win, needle, timeout = BUILD_TIMEOUT) {
    return waitFor(async () => {
        const frame = await viewerFrame(win)
        return (await pdfText(frame)).includes(needle)
    }, timeout, `PDF to contain ${needle}`)
}

/** In sync = latexmk's recorded md5 for the file equals the file on disk. */
function compiledMd5(relFile) {
    const fdb = fs.readFileSync(path.join(PROJECT, 'main.fdb_latexmk'), 'utf8')
    const name = relFile.replace(/\\/g, '/')
    // latexmk lists a source relative ("main.tex", "./main.tex") or absolute ("c:/proj/main.tex")
    return new RegExp(`"(?:[^"]*/)?${name.replace(/[.\\/]/g, '\\$&')}" \\S+ \\d+ ([0-9a-f]{32})`).exec(fdb)?.[1]
}

async function inverseSearch(win, frame, marker, relFile) {
    // pdf.js only renders text layers near the viewport: bring the marker's page in first
    await frame.evaluate(async m => {
        const doc = window.PDFViewerApplication.pdfDocument
        for (let i = 1; i <= doc.numPages; i++) {
            const content = await (await doc.getPage(i)).getTextContent()
            if (content.items.some(item => item.str.includes(m))) {
                window.PDFViewerApplication.page = i
                return
            }
        }
    }, marker)
    const span = frame.locator('.textLayer span', { hasText: marker }).first()
    await span.scrollIntoViewIfNeeded()
    await sleep(400)
    await span.dblclick()
    const expected = lineOf(relFile, marker)
    try {
        await waitFor(async () => (await win.title()).includes(path.basename(relFile))
            && (await cursorLine(win)) === expected, 5000, `jump to ${relFile}:${expected}`)
        return { ok: true, detail: `${relFile}:${expected}` }
    } catch {
        return { ok: false, detail: `got ${await win.title()} Ln ${await cursorLine(win)}, want ${relFile}:${expected}` }
    }
}

async function testBuildAndView(win) {
    await openFile(win, 'main.tex')
    const start = Date.now()
    await runCommand(win, 'LaTeX Workshop: Build LaTeX project')
    // synctex.gz appears after the first pass; wait for latexmk's last pass (fdb records main.tex)
    const main = path.join(PROJECT, 'main.tex')
    await waitFor(async () => compiledMd5('main.tex') === md5(main) && fs.existsSync(path.join(PROJECT, 'main.synctex.gz')),
        BUILD_TIMEOUT, 'first build')
    check('first build produces PDF + SyncTeX', true, `${Date.now() - start} ms incl. bibtex`)
    await sleep(1000) // LW refreshes viewers right after BUILD_DONE
    await runCommand(win, 'LaTeX Workshop: View LaTeX PDF file')
    const frame = await viewerFrame(win)
    const pages = await frame.evaluate(() => window.PDFViewerApplication.pagesCount)
    check('PDF opens in a VS Code tab', pages >= 3, `${pages} pages`)
    const text = await pdfText(frame)
    check('multi-file content, citation, table, figure in PDF',
        ['ALPHAONE', 'BETATWO', 'GAMMAROW', 'FIGCAP', 'OMEGAEND', 'Knuth'].every(m => text.includes(m)))
}

async function testForwardSync(win) {
    const frame = await viewerFrame(win)
    await recordIndicators(frame)
    await openFile(win, 'sections/results.tex')
    await waitFor(async () => (await syncStatus(win)).trim() === 'SyncTeX', 10000, 'status in sync').catch(() => undefined)
    check('status bar shows in-sync', (await syncStatus(win)).trim() === 'SyncTeX', await syncStatus(win))

    let before = await indicatorCount(frame)
    await gotoLine(win, lineOf('sections/results.tex', 'BETAONE'))
    await sleep(800)
    check('Go to Line (API move) does not scroll the PDF', (await indicatorCount(frame)) === before)

    for (const marker of ['BETATWO', 'FIGCAP', 'GAMMAROW']) {
        before = await indicatorCount(frame)
        const clickedAt = Date.now()
        await clickLine(win, lineOf('sections/results.tex', marker))
        const hit = await nextIndicator(frame, before).catch(e => ({ text: e.message }))
        check(`click source line -> PDF highlights ${marker}`, hit.text.includes(marker) && hit.visible,
            `${hit.at - clickedAt} ms, visible=${hit.visible}, text="${hit.text.slice(0, 60)}"`)
    }

    await openFile(win, 'main.tex')
    before = await indicatorCount(frame)
    await clickLine(win, lineOf('main.tex', 'OMEGAEND'))
    const root = await nextIndicator(frame, before).catch(e => ({ text: e.message }))
    check('click in root file -> PDF last page', root.text.includes('OMEGAEND'), `"${root.text.slice(0, 60)}"`)
}

async function testCursorBurst(win) {
    const frame = await viewerFrame(win)
    await openFile(win, 'sections/intro.tex')
    await clickLine(win, 1)
    await sleep(1200)
    const before = await indicatorCount(frame)
    const target = lineOf('sections/intro.tex', 'ALPHATHREE')
    for (let i = 1; i < target; i++) {
        await win.keyboard.press('ArrowDown')
        await sleep(40)
    }
    const hit = await nextIndicator(frame, before)
    await sleep(800)
    const syncs = (await indicatorCount(frame)) - before
    check('rapid arrow keys are debounced', syncs <= 2, `${target - 1} key presses -> ${syncs} PDF syncs`)
    check('PDF ends on the final cursor line', hit.text.includes('ALPHATHREE'), `"${hit.text.slice(0, 60)}"`)
}

async function testInverseSearch(win) {
    const frame = await viewerFrame(win)
    await recordIndicators(frame)
    await frame.evaluate(() => { window.PDFViewerApplication.pdfViewer.currentScaleValue = 'page-width' })
    await sleep(800)
    const before = await indicatorCount(frame)
    const cases = [
        ['ALPHATWO', 'sections/intro.tex', 'page-width'],
        ['ALPHATHREE', 'sections/intro.tex', '2'],
        ['GAMMAROW', 'sections/results.tex', '2'],
        ['FIGCAP', 'sections/results.tex', '0.75'],
        ['BETATWO', 'sections/results.tex', '1.5'],
        ['OMEGAEND', 'main.tex', '0.75'],
    ]
    for (const [marker, file, scale] of cases) {
        await frame.evaluate(s => { window.PDFViewerApplication.pdfViewer.currentScaleValue = s }, scale)
        await sleep(600)
        // scroll somewhere else first so the click happens at a non-zero, non-initial scroll offset
        await frame.evaluate(() => { document.getElementById('viewerContainer').scrollTop += 137 })
        const result = await inverseSearch(win, frame, marker, file)
        check(`double-click PDF "${marker}" at zoom ${scale} -> source line`, result.ok, result.detail)
    }
    await sleep(800)
    check('inverse search does not bounce back into a forward sync', (await indicatorCount(frame)) === before)
    await frame.evaluate(() => { window.PDFViewerApplication.pdfViewer.currentScaleValue = 'page-width' })
}

async function testLiveCompile(win) {
    const frame = await viewerFrame(win)
    await openFile(win, 'sections/intro.tex')
    await gotoLine(win, lineOf('sections/intro.tex', 'ALPHAONE'))
    await win.keyboard.press('End')
    await win.keyboard.type(' LIVEDELTA', { delay: 40 })
    const typedAt = Date.now()
    await sleep(150)
    check('status shows stale while unsaved', (await syncStatus(win)).includes('out of date'), await syncStatus(win))

    const before = await indicatorCount(frame)
    await clickLine(win, lineOf('sections/intro.tex', 'ALPHATWO'))
    await sleep(500)
    check('stale file: cursor move does not sync to old line numbers', (await indicatorCount(frame)) === before)

    await waitForPdfText(win, 'LIVEDELTA')
    check('typing without saving -> PDF updates', true, `${Date.now() - typedAt} ms after last keystroke`)
    await waitFor(async () => !(await syncStatus(win)).includes('out of date'), 10000, 'in sync').catch(() => undefined)
    check('status returns to in-sync after build', !(await syncStatus(win)).includes('out of date'), await syncStatus(win))
    const after = await indicatorCount(frame)
    await clickLine(win, lineOf('sections/intro.tex', 'ALPHATWO'))
    const hit = await nextIndicator(frame, after).catch(e => ({ text: e.message }))
    check('after rebuild cursor sync works again', hit.text.includes('ALPHATWO'), `"${hit.text.slice(0, 60)}"`)
}

async function testEditsDuringCompile(win) {
    await openFile(win, 'sections/results.tex')
    await gotoLine(win, lineOf('sections/results.tex', 'BETAONE'))
    await win.keyboard.press('End')
    // each pause > autosave delay, so saves (and builds) land while the next edit is being typed
    for (let i = 1; i <= 5; i++) {
        await win.keyboard.type(` RAPID${i}`, { delay: 30 })
        await sleep(i === 5 ? 0 : 1000)
    }
    const lastEdit = Date.now()
    await waitForPdfText(win, 'RAPID5')
    await sleep(3000) // any late, older build would land here
    const text = await pdfText(await viewerFrame(win))
    check('edits during compile: final PDF has the newest text', ['RAPID1', 'RAPID5'].every(m => text.includes(m)),
        `${Date.now() - lastEdit - 3000} ms to RAPID5`)
    const file = path.join(PROJECT, 'sections', 'results.tex')
    check('fdb md5 matches disk (no stale build won)', compiledMd5('sections/results.tex') === md5(file))
}

async function testCompileError(win) {
    await openFile(win, 'sections/results.tex')
    const errorLine = lineOf('sections/results.tex', 'BETAONE')
    await gotoLine(win, errorLine)
    await win.keyboard.press('End')
    await win.keyboard.type(' ERRWORD \\undefinedcmdxyz', { delay: 30 })
    await win.keyboard.press('Escape')
    await win.keyboard.press('Control+Shift+M')
    const row = win.locator('.markers-panel .monaco-list-row', { hasText: 'Undefined control sequence' }).first()
    try {
        await row.waitFor({ timeout: BUILD_TIMEOUT })
        check('compile error appears in Problems panel', true, (await row.innerText()).replace(/\s+/g, ' ').slice(0, 90))
    } catch {
        check('compile error appears in Problems panel', false)
        return
    }
    await gotoLine(win, 1)
    await row.click()
    await waitFor(async () => (await win.title()).includes('results.tex') && (await cursorLine(win)) === errorLine,
        5000, 'jump to error').then(() => check('click problem -> jumps to file:line', true, `results.tex:${errorLine}`),
        async () => check('click problem -> jumps to file:line', false, `Ln ${await cursorLine(win)}`))
    // latexmk still writes PDF + SyncTeX on errors; the viewer must show that PDF or the mapping is off
    await waitForPdfText(win, 'ERRWORD', 10000).then(
        async () => check('failed build: viewer shows the PDF its SyncTeX describes', true, await syncStatus(win)),
        async () => check('failed build: viewer shows the PDF its SyncTeX describes', false, await syncStatus(win)))

    await openFile(win, 'sections/results.tex')
    await gotoLine(win, errorLine)
    await win.keyboard.press('End')
    for (let i = 0; i < ' \\undefinedcmdxyz'.length; i++) await win.keyboard.press('Backspace')
    const file = path.join(PROJECT, 'sections', 'results.tex')
    await waitFor(async () => !fs.readFileSync(file, 'utf8').includes('undefinedcmdxyz'), 10000, 'fix autosaved')
    await waitFor(async () => compiledMd5('sections/results.tex') === md5(file), BUILD_TIMEOUT, 'fixed source compiled')
    await waitFor(async () => (await win.locator('.markers-panel .monaco-list-row',
        { hasText: 'Undefined control sequence' }).count()) === 0, BUILD_TIMEOUT, 'error cleared')
        .then(() => check('fixing the error clears Problems', true), () => check('fixing the error clears Problems', false))
    await waitForPdfText(win, 'ERRWORD').then(() => check('PDF updated after fix', true), () => check('PDF updated after fix', false))
}

async function testXelatexRecipe(win) {
    await openFile(win, 'main.tex')
    await runCommand(win, 'LaTeX Workshop: Build with recipe')
    await win.waitForSelector('.quick-input-list .monaco-list-row[aria-label*="latexmk (xelatex)"]', { timeout: 10000 })
    await win.keyboard.type('latexmk (xelatex)')
    await sleep(300)
    await win.keyboard.press('Enter')
    const fdb = path.join(PROJECT, 'main.fdb_latexmk')
    await waitFor(async () => fs.readFileSync(fdb, 'utf8').includes('["xelatex"]'), BUILD_TIMEOUT, 'xelatex run')
    check('xelatex recipe builds via latexmk', true)
    const frame = await viewerFrame(win)
    await recordIndicators(frame)
    await openFile(win, 'sections/results.tex')
    await waitFor(async () => (await syncStatus(win)).trim() === 'SyncTeX', 15000, 'in sync').catch(() => undefined)
    const before = await indicatorCount(frame)
    await clickLine(win, lineOf('sections/results.tex', 'FIGCAP'))
    const hit = await nextIndicator(frame, before).catch(e => ({ text: e.message }))
    check('xelatex: cursor sync highlights FIGCAP', hit.text.includes('FIGCAP'), `"${hit.text.slice(0, 60)}"`)
    const inverse = await inverseSearch(win, frame, 'BETATWO', 'sections/results.tex')
    check('xelatex: inverse search', inverse.ok, inverse.detail)
    // Known LW limitation: its JS backward search (not the synctex binary) picks a nearby line in XeTeX tables.
    const table = await inverseSearch(win, frame, 'GAMMAROW', 'sections/results.tex')
    console.log(`      note: xelatex table cell inverse search -> ${table.ok ? 'exact' : table.detail}`)
}

/** Edits `relFile` on `marker`'s line, waits until latexmk ran on it, returns whether a click still syncs. */
async function editAndProbe(win, relFile, marker, edit) {
    const frame = await viewerFrame(win)
    await openFile(win, relFile)
    await gotoLine(win, lineOf(relFile, marker))
    await win.keyboard.press('End')
    await win.keyboard.type(edit, { delay: 30 })
    const file = path.join(PROJECT, relFile)
    await waitFor(async () => fs.readFileSync(file, 'utf8').includes(edit.trim()), 10000, 'autosave')
    await waitFor(async () => compiledMd5(relFile) === md5(file), BUILD_TIMEOUT, 'latexmk ran on the edit')
    await sleep(1500)
    const before = await indicatorCount(frame)
    await clickLine(win, lineOf(relFile, marker))
    await sleep(1200)
    return { synced: (await indicatorCount(frame)) > before, status: await syncStatus(win) }
}

async function undoEdit(win, relFile, marker, edit) {
    await gotoLine(win, lineOf(relFile, marker))
    await win.keyboard.press('End')
    for (let i = 0; i < edit.length; i++) await win.keyboard.press('Backspace')
    const file = path.join(PROJECT, relFile)
    await waitFor(async () => !fs.readFileSync(file, 'utf8').includes(edit.trim()), 10000, 'autosave')
    await waitFor(async () => compiledMd5(relFile) === md5(file), BUILD_TIMEOUT, 'rebuild after undo')
    await waitFor(async () => (await syncStatus(win)).trim() === 'SyncTeX', 15000, 'in sync').catch(() => undefined)
}

async function testErrorsWithoutMatchingPdf(win) {
    // xelatex + error: latexmk skips xdvipdfmx, so the PDF is older than the fresh SyncTeX
    const xeEdit = ' \\undefinedcmdxyz'
    const xe = await editAndProbe(win, 'sections/results.tex', 'BETATWO', xeEdit)
    check('xelatex error (stale PDF): follow paused, status out of date',
        !xe.synced && xe.status.includes('out of date'), `synced=${xe.synced}, "${xe.status}"`)
    await undoEdit(win, 'sections/results.tex', 'BETATWO', xeEdit)
    check('xelatex error fixed: back in sync', (await syncStatus(win)).trim() === 'SyncTeX', await syncStatus(win))

    // fatal error: no PDF written, SyncTeX deleted
    const fatalEdit = '\\usepackage{nonexistentpkgxyz}'
    const fatal = await editAndProbe(win, 'main.tex', '\\usepackage{hyperref}', fatalEdit)
    check('fatal error (no PDF): follow paused, status out of date',
        !fatal.synced && fatal.status.includes('out of date'), `synced=${fatal.synced}, "${fatal.status}"`)
    await undoEdit(win, 'main.tex', '\\usepackage{hyperref}', fatalEdit)
    const frame = await viewerFrame(win)
    const before = await indicatorCount(frame)
    await clickLine(win, lineOf('main.tex', 'OMEGAEND'))
    const hit = await nextIndicator(frame, before).catch(e => ({ text: e.message }))
    check('fatal error fixed: follow works again', hit.text.includes('OMEGAEND'), `"${hit.text.slice(0, 60)}"`)
}

async function testRestart(app) {
    await app.close()
    const { app: reopened, win } = await launch()
    try {
        const frame = await viewerFrame(win)
        check('reopen VS Code: PDF tab restored', true)
        await recordIndicators(frame)
        await openFile(win, 'sections/results.tex')
        await waitFor(async () => !(await syncStatus(win)).includes('out of date') && (await syncStatus(win)) !== '',
            15000, 'status').catch(() => undefined)
        const before = await indicatorCount(frame)
        await clickLine(win, lineOf('sections/results.tex', 'BETATWO'))
        const hit = await nextIndicator(frame, before).catch(e => ({ text: e.message }))
        check('after reopen cursor sync works', hit.text.includes('BETATWO'), `"${hit.text.slice(0, 60)}"`)
        const inverse = await inverseSearch(win, frame, 'ALPHATWO', 'sections/intro.tex')
        check('after reopen inverse search works', inverse.ok, inverse.detail)
    } finally {
        await reopened.close()
    }
}

async function main() {
    prepare(AUTO_BUILD)
    const { app, win } = await launch()
    let closed = false
    try {
        const only = process.env.E2E_ONLY?.split(',')
        const steps = [testBuildAndView, testForwardSync, testCursorBurst, testInverseSearch,
            testLiveCompile, testEditsDuringCompile, testCompileError, testXelatexRecipe, testErrorsWithoutMatchingPdf]
        for (const step of steps.filter(s => s === testBuildAndView || !only || only.includes(s.name))) {
            try {
                await step(win)
            } catch (e) {
                check(`${step.name} crashed`, false, e.message.split('\n')[0])
                await win.screenshot({ path: path.join(WORK, `${step.name}.png`) }).catch(() => undefined)
            }
        }
        closed = true
        if (only && !only.includes('testRestart')) await app.close()
        else await testRestart(app)
    } finally {
        if (!closed) await app.close()
    }
    summary()
}

main().catch(e => {
    console.error(e)
    process.exitCode = 1
})
