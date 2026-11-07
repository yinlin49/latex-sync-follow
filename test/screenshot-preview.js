'use strict'
// Visual check: renders a real document in the Live Preview and screenshots the page, next to the PDF
// LaTeX builds from the same source. Usage: node test/screenshot-preview.js <dir-with-tex> <root.tex>
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { WORK, sleep, waitFor, prepare, launch, runCommand, openFile } = require('./driver')

async function main() {
    const [sourceDir, root] = process.argv.slice(2)
    const files = Object.fromEntries(fs.readdirSync(sourceDir)
        .filter(f => /\.(tex|cls|sty|bib|png|jpg)$/i.test(f))
        .map(f => [f, fs.readFileSync(path.join(sourceDir, f), /\.(png|jpg)$/i.test(f) ? null : 'utf8')]))
    prepare({}, files)
    const pdfDir = path.join(WORK, 'pdf')
    fs.rmSync(pdfDir, { recursive: true, force: true })
    fs.mkdirSync(pdfDir)
    for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(pdfDir, name), data)
    spawnSync('latexmk', ['-pdf', '-interaction=nonstopmode', root], { cwd: pdfDir, encoding: 'utf8' })
    spawnSync('pdftoppm', ['-png', '-r', '96', '-f', '1', '-l', '1', root.replace(/\.tex$/, '.pdf'), path.join(WORK, 'pdf-page')], { cwd: pdfDir })
    const { app, win } = await launch()
    try {
        // a wide window: the preview group gets about one PDF page of width
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 2000, height: 1400 }))
        await sleep(500)
        await openFile(win, root)
        await runCommand(win, 'LaTeX: Open Live Preview')
        const frame = await waitFor(async () => {
            for (const f of win.frames()) {
                if (await f.evaluate(() => Boolean(document.querySelector('#doc .lp-block'))).catch(() => false)) return f
            }
            return undefined
        }, 30000, 'preview')
        await sleep(1500)
        await frame.locator('#doc').screenshot({ path: path.join(WORK, 'preview-page.png') })
        console.log(`preview: ${path.join(WORK, 'preview-page.png')}`)
        console.log(`pdf:     ${fs.readdirSync(WORK).filter(f => f.startsWith('pdf-page')).map(f => path.join(WORK, f)).join(', ')}`)
    } finally {
        await app.close()
    }
}

main().catch(e => {
    console.error(e)
    process.exitCode = 1
})
