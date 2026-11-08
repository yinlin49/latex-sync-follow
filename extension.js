'use strict'
// Cursor -> PDF follow for LaTeX Workshop: runs LW's real SyncTeX forward search when the cursor
// moves, but only while the file on disk is exactly what latexmk compiled into the open PDF.
const vscode = require('vscode')
const fs = require('fs/promises')
const crypto = require('crypto')
const path = require('path')
const { parseFdb, normalizePath } = require('./lib/fdb')
const { LOG_ERROR } = require('./lib/latex-log')
const { activatePreview } = require('./preview')

const DEBOUNCE_MS = 250
// Same list as LaTeX Workshop's hasLaTeXLangId; its synctex command refuses other languages.
const LATEX_LANGS = ['latex', 'context', 'latex-expl3', 'pweave', 'jlweave', 'rsweave', 'doctex']
const PDF_VIEW_TYPE = 'latex-workshop-pdf'
const { Keyboard, Mouse } = vscode.TextEditorSelectionChangeKind

// PDF and SyncTeX are written at the end of the same run; allow for the gap between the two writes.
const SAME_RUN_SLACK_MS = 1000

/** fdb file uri -> { pdfName, runId, md5ByPath: source path -> md5 latexmk compiled } */
const compiledByFdb = new Map()
/** fdb file uri -> latest load request, so an older slow load never overwrites a newer one */
const loadSeqByFdb = new Map()
let log
let status
let followTimer
let lastFollowedLine
let refreshSeq = 0

function activate(context) {
    log = vscode.window.createOutputChannel('LaTeX SyncTeX Follow', { log: true })
    status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    status.command = 'latexSyncFollow.toggle'
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.fdb_latexmk')
    context.subscriptions.push(
        log,
        status,
        watcher,
        watcher.onDidCreate(loadFdb),
        watcher.onDidChange(loadFdb),
        watcher.onDidDelete(uri => {
            compiledByFdb.delete(uri.toString())
            void refreshStatus()
        }),
        vscode.commands.registerCommand('latexSyncFollow.toggle', toggleFollow),
        vscode.window.onDidChangeTextEditorSelection(onSelectionChange),
        vscode.window.onDidChangeActiveTextEditor(() => void refreshStatus()),
        vscode.window.tabGroups.onDidChangeTabs(() => void refreshStatus()),
        vscode.workspace.onDidSaveTextDocument(() => void refreshStatus()),
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document === vscode.window.activeTextEditor?.document) void refreshStatus()
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('latexSyncFollow')) void refreshStatus()
        }),
        { dispose: () => clearTimeout(followTimer) },
    )
    void vscode.workspace
        .findFiles('**/*.fdb_latexmk')
        .then(uris => Promise.all(uris.map(loadFdb)))
        .then(refreshStatus)
    activatePreview(context, log, isLatex)
}

async function loadFdb(uri) {
    const key = uri.toString()
    const seq = (loadSeqByFdb.get(key) ?? 0) + 1
    loadSeqByFdb.set(key, seq)
    // shortcut: assumes PDF, SyncTeX and .log sit next to the .fdb_latexmk (LW default: outDir = auxDir).
    const base = uri.fsPath.replace(/\.fdb_latexmk$/, '')
    let fdbStat, md5ByPath, runLog, pdf, synctex
    try {
        fdbStat = await fs.stat(uri.fsPath)
        md5ByPath = parseFdb(await fs.readFile(uri.fsPath, 'utf8'), path.dirname(uri.fsPath))
        runLog = await fs.readFile(`${base}.log`, 'latin1').catch(() => '')
        ;[pdf, synctex] = await Promise.all([`${base}.pdf`, `${base}.synctex.gz`].map(f => fs.stat(f).catch(() => null)))
    } catch (e) {
        log.warn(`cannot read ${uri.fsPath}: ${e.message}`)
        return
    }
    if (loadSeqByFdb.get(key) !== seq) return // a newer change event is already loading
    const runId = `${fdbStat.mtimeMs}:${fdbStat.size}`
    if (compiledByFdb.get(key)?.runId === runId) return // duplicate event for the same run
    // A truncated read (latexmk mid-write) only drops entries: it fails safe as "out of date" until the next event.
    if (!pdf || !synctex || pdf.mtimeMs + SAME_RUN_SLACK_MS < synctex.mtimeMs) {
        // Fatal error (no PDF, SyncTeX deleted) or xelatex error (xdvipdfmx skipped, PDF older than SyncTeX):
        // the PDF on screen does not match the SyncTeX data, so no source can be trusted.
        log.info(`PDF and SyncTeX are not from the same run: ${base}`)
        md5ByPath = new Map()
    }
    compiledByFdb.set(key, { pdfName: path.basename(`${base}.pdf`), runId, md5ByPath })
    lastFollowedLine = undefined // a new PDF is shown, re-sync even on the same line
    if (md5ByPath.size > 0 && LOG_ERROR.test(runLog)) {
        // LW skips the viewer refresh on failed builds, yet latexmk already wrote the new PDF and
        // SyncTeX; reload so the viewer shows the PDF that the SyncTeX data describes.
        log.info(`compile had errors, refreshing viewer: ${base}`)
        await Promise.resolve(vscode.commands.executeCommand('latex-workshop.refresh-viewer')).catch(e =>
            log.warn(`refresh-viewer failed: ${e.message}`),
        )
    }
    await refreshStatus()
}

/** Names of compiled PDFs whose SyncTeX data was produced from exactly this saved file. */
async function syncedPdfNames(document) {
    if (document.isDirty || document.uri.scheme !== 'file') return []
    const key = normalizePath(document.uri.fsPath)
    const candidates = [...compiledByFdb.values()].filter(c => c.md5ByPath.has(key))
    if (candidates.length === 0) return []
    const onDisk = crypto
        .createHash('md5')
        .update(await fs.readFile(document.uri.fsPath))
        .digest('hex')
    return candidates.filter(c => c.md5ByPath.get(key) === onDisk).map(c => c.pdfName)
}

function followEnabled() {
    return vscode.workspace.getConfiguration('latexSyncFollow').get('enabled', true)
}

function isLatex(document) {
    return LATEX_LANGS.includes(document.languageId)
}

function openPdfTabNames() {
    // LW's synctex command opens a new viewer when none exists; never do that from a cursor move.
    // The viewer is a webview panel or, when opened on a .pdf, the custom editor 'latex-workshop-pdf-hook';
    // both are titled with the PDF's file name.
    return vscode.window.tabGroups.all
        .flatMap(group => group.tabs)
        .filter(tab => /** @type {{ viewType?: string } | undefined} */ (tab.input)?.viewType?.includes(PDF_VIEW_TYPE))
        .map(tab => tab.label)
}

function onSelectionChange(event) {
    log.trace(`selection kind=${event.kind} lang=${event.textEditor.document.languageId}`)
    // API-driven moves (inverse search from the PDF, go-to-line, undo) are not followed: no PDF<->source loop.
    if (event.kind !== Keyboard && event.kind !== Mouse) return
    if (!followEnabled() || !isLatex(event.textEditor.document)) return
    clearTimeout(followTimer)
    followTimer = setTimeout(() => void followCursor(event.textEditor, event.kind), DEBOUNCE_MS)
}

async function followCursor(editor, kind) {
    const line = `${editor.document.uri}:${editor.selection.active.line}`
    if (editor !== vscode.window.activeTextEditor) return
    if (openPdfTabNames().length === 0) {
        log.debug(`skip ${line}: no PDF tab open`)
        return
    }
    // Arrow keys within one line would re-flash the same box; a click always re-syncs.
    if (kind === Keyboard && line === lastFollowedLine) return
    const synced = await syncedPdfNames(editor.document).catch(() => [])
    if (!synced.some(name => openPdfTabNames().includes(name))) {
        log.debug(`skip ${line}: no open PDF was compiled from this file as saved`)
        await refreshStatus()
        return
    }
    if (editor !== vscode.window.activeTextEditor) return
    lastFollowedLine = line
    log.debug(`forward SyncTeX ${line}`)
    await vscode.commands.executeCommand('latex-workshop.synctex')
}

async function toggleFollow() {
    await vscode.workspace.getConfiguration('latexSyncFollow').update('enabled', !followEnabled(), vscode.ConfigurationTarget.Global)
}

async function refreshStatus() {
    const seq = ++refreshSeq
    const editor = vscode.window.activeTextEditor
    // the PDF state only matters while a PDF tab is open (live preview users export on demand)
    if (!editor || !isLatex(editor.document) || openPdfTabNames().length === 0) {
        status.hide()
        return
    }
    const inSync = (await syncedPdfNames(editor.document).catch(() => [])).length > 0
    if (seq !== refreshSeq) return // a newer refresh already ran
    if (!followEnabled()) {
        status.text = '$(circle-slash) SyncTeX follow off'
        status.tooltip = 'Cursor → PDF follow is off. Click to turn it on.'
    } else if (inSync) {
        status.text = '$(link) SyncTeX'
        status.tooltip = 'PDF matches this file. Moving the cursor scrolls the PDF. Click to turn off.'
    } else {
        status.text = '$(warning) SyncTeX: PDF out of date'
        status.tooltip =
            'This file differs from the last compile (unsaved, compiling, or not compiled yet). ' +
            'Cursor → PDF is paused; PDF → source jumps use the old line numbers until the next compile.'
    }
    status.show()
}

function deactivate() {}

module.exports = { activate, deactivate }
