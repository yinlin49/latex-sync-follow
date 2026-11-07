'use strict'
// Shared Playwright driver for the end-to-end suites: a separate, real VS Code (Electron) with
// LaTeX Workshop installed and this extension loaded from source.
const { _electron } = require('playwright-core')
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const REPO = path.resolve(__dirname, '..')
const VSCODE_DIR = path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code')
const CODE_EXE = path.join(VSCODE_DIR, 'Code.exe')
const CODE_CLI = path.join(VSCODE_DIR, 'bin', 'code.cmd')
const LW_ID = 'james-yu.latex-workshop@10.20.0'
const WORK = process.env.E2E_DIR || path.join(os.tmpdir(), 'latex-sync-follow-e2e')
const PROJECT = path.join(WORK, 'project')
const USER_DATA = path.join(WORK, 'user-data')
const EXTENSIONS = path.join(WORK, 'extensions')

const results = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function check(name, ok, detail = '') {
    results.push({ name, ok, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

function lineOf(relFile, marker) {
    const lines = fs.readFileSync(path.join(PROJECT, relFile), 'utf8').split(/\r?\n/)
    const index = lines.findIndex(line => line.includes(marker))
    if (index < 0) throw new Error(`${marker} not in ${relFile}`)
    return index + 1
}

function md5(file) {
    return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex')
}

async function waitFor(fn, timeout, what) {
    const start = Date.now()
    while (Date.now() - start < timeout) {
        const value = await fn().catch(() => undefined)
        if (value) return value
        await sleep(100)
    }
    throw new Error(`timeout waiting for ${what}`)
}

/** Fresh copy of the fixture and a clean VS Code profile using latex-settings.json plus `overrides`. */
function prepare(overrides = {}, extraFiles = {}) {
    fs.rmSync(PROJECT, { recursive: true, force: true })
    fs.rmSync(USER_DATA, { recursive: true, force: true })
    fs.cpSync(path.join(REPO, 'test', 'fixture'), PROJECT, { recursive: true })
    for (const [name, text] of Object.entries(extraFiles)) fs.writeFileSync(path.join(PROJECT, name), text)
    const settings = {
        ...JSON.parse(fs.readFileSync(path.join(REPO, 'latex-settings.json'), 'utf8')),
        'workbench.startupEditor': 'none',
        'security.workspace.trust.enabled': false,
        'update.mode': 'none',
        'extensions.autoUpdate': false,
        ...overrides,
    }
    fs.mkdirSync(path.join(USER_DATA, 'User'), { recursive: true })
    fs.writeFileSync(path.join(USER_DATA, 'User', 'settings.json'), JSON.stringify(settings, null, 4))
    if (!fs.existsSync(EXTENSIONS) || !fs.readdirSync(EXTENSIONS).some(d => d.startsWith('james-yu.latex-workshop'))) {
        const install = spawnSync(`"${CODE_CLI}" --extensions-dir "${EXTENSIONS}" --install-extension ${LW_ID}`,
            { shell: true, encoding: 'utf8' })
        if (install.status !== 0) throw new Error(`LaTeX Workshop install failed: ${install.stderr}`)
    }
}

async function launch() {
    const app = await _electron.launch({
        executablePath: CODE_EXE,
        args: [PROJECT, `--user-data-dir=${USER_DATA}`, `--extensions-dir=${EXTENSIONS}`,
            `--extensionDevelopmentPath=${REPO}`, '--skip-welcome', '--skip-release-notes',
            '--disable-workspace-trust', '--new-window', '--log=local.latex-sync-follow:trace'],
        timeout: 90000,
    })
    const win = await app.firstWindow()
    await win.waitForSelector('.monaco-workbench', { timeout: 90000 })
    await sleep(3000) // let extensions activate
    return { app, win }
}

async function runCommand(win, title) {
    await win.keyboard.press('F1')
    await win.waitForSelector('.quick-input-widget input', { state: 'visible' })
    await win.keyboard.type(title)
    await win.waitForSelector(`.quick-input-list .monaco-list-row[aria-label*="${title}"]`, { timeout: 10000 })
    await win.keyboard.press('Enter')
}

async function openFile(win, relFile) {
    // open sources in the first group, never on top of the PDF / preview tab
    await win.keyboard.press('Control+1')
    await win.keyboard.press('Control+P')
    await win.waitForSelector('.quick-input-widget input', { state: 'visible' })
    await win.keyboard.type(relFile.replace(/\\/g, '/'))
    await sleep(700)
    await win.keyboard.press('Enter')
    await waitFor(async () => (await win.title()).includes(path.basename(relFile)), 10000, `${relFile} active`)
    await sleep(300)
}

async function cursorLine(win) {
    // absent while a non-text editor (the PDF or preview tab) is active
    const text = await win.locator('[id="status.editor.selection"]').innerText({ timeout: 1000 }).catch(() => '')
    return Number(/Ln (\d+)/.exec(text)?.[1])
}

/** Moves the cursor with Go to Line (an API move: must not trigger follow). */
async function gotoLine(win, line) {
    await win.keyboard.press('Control+G')
    await win.waitForSelector('.quick-input-widget input', { state: 'visible' })
    await win.keyboard.type(String(line))
    await win.keyboard.press('Enter')
    await waitFor(async () => (await cursorLine(win)) === line, 5000, `cursor at ${line}`)
}

/** A real mouse click on the text of `line` in the focused editor. */
async function clickLine(win, line) {
    await gotoLine(win, line)
    const box = await win.evaluate(n => {
        const editor = document.querySelector('.monaco-editor.focused')
        const number = [...editor.querySelectorAll('.line-numbers')].find(el => el.textContent.trim() === String(n))
        const r = number.getBoundingClientRect()
        return { x: r.right + 60, y: r.top + r.height / 2 }
    }, line)
    await win.mouse.click(box.x, box.y)
    await waitFor(async () => (await cursorLine(win)) === line, 5000, `click on ${line}`)
}

/** Saves all editors, so lineOf() (which reads files on disk) sees the edited text. */
async function saveAll(win) {
    await runCommand(win, 'File: Save All')
    await sleep(300)
}

function summary() {
    const failed = results.filter(r => !r.ok)
    console.log(`\n${results.length - failed.length}/${results.length} passed`)
    process.exitCode = failed.length ? 1 : 0
}

module.exports = {
    WORK, PROJECT, results, sleep, check, lineOf, md5, waitFor, prepare, launch,
    runCommand, openFile, cursorLine, gotoLine, clickLine, saveAll, summary,
}
