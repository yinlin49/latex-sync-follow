'use strict'
// Live Preview tab: renders the LaTeX project into a webview on every edit, without building a PDF.
// "Export PDF" runs LaTeX Workshop's real build (latexmk) only when asked.
const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const cp = require('child_process')
const crypto = require('crypto')
const { LivePreviewModel, findMarkerLine } = require('./dist/renderer.js')
const { LOG_ERROR } = require('./lib/latex-log')

const VIEW_TYPE = 'latexLivePreview'
const REVEAL_DEBOUNCE_MS = 30
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.pdf', '.eps']
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_SAMPLES = 5000
const ACK_TIMEOUT_MS = 2000
const KPSEWHICH_DELAY_MS = 400
const JUMP_HIGHLIGHT_MS = 1500
const REFOCUS_CHECK_MS = 150
const SAME_RUN_SLACK_MS = 1000
const INCLUDE = /\\(?:input|include)\s*\{([^}]+)\}/g
const MAGIC_ROOT = /^\s*%\s*!TeX\s+root\s*=\s*(.+?)\s*$/im
const { Keyboard, Mouse } = vscode.TextEditorSelectionChangeKind

const normalize = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/** Open editor text, else disk text, without caching (used to scan candidate root files). */
function readUncached(file) {
    const open = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && normalize(d.uri.fsPath) === normalize(file))
    if (open) return open.getText()
    try {
        return fs.readFileSync(file, 'utf8')
    } catch {
        return undefined
    }
}

/**
 * Does `file` \input/\include `target` (normalized), directly or transitively?
 * shortcut: a textual scan that only skips whole-line comments; good enough to pick a root file.
 */
function includesFile(file, target, chain) {
    if (chain.length > 8 || chain.includes(normalize(file))) return false
    const text = readUncached(file)
    if (text === undefined) return false
    const code = text
        .split(/\r?\n/)
        .filter(line => !/^\s*%/.test(line))
        .join('\n')
    for (const [, name] of code.matchAll(INCLUDE)) {
        const included = path.resolve(path.dirname(chain[0] ?? file), path.extname(name) ? name : `${name}.tex`)
        if (normalize(included) === target || includesFile(included, target, [...chain, normalize(file)])) return true
    }
    return false
}

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : NaN)

class LivePreview {
    constructor(context, log, isLatex) {
        this.context = context
        this.log = log
        this.isLatex = isLatex
        this.diskText = new Map()
        this.images = new Map()
        this.model = new LivePreviewModel({ readText: f => this.readText(f), resolveImage: (dir, name) => this.resolveImage(dir, name) })
        this.files = new Map() // normalized path -> path string used by the model
        this.sentKeys = new Set()
        this.version = 0
        this.latencies = []
        this.renderTimes = []
        this.usedImages = new Set()
        this.rootSeq = 0
        // the source line a preview click jumped to flashes briefly
        this.jumpDecoration = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
        })
        context.subscriptions.push(this.jumpDecoration)
    }

    // ---- panel ----

    async open() {
        const editor = vscode.window.activeTextEditor
        if (editor && this.isLatex(editor.document)) {
            this.sourceColumn = editor.viewColumn
            this.root = await this.resolveRoot(editor.document)
        }
        if (!this.root) {
            void vscode.window.showWarningMessage('Open a .tex file first to start the live preview.')
            return
        }
        if (this.panel) {
            this.panel.reveal(undefined, true)
        } else {
            this.attach(
                vscode.window.createWebviewPanel(
                    VIEW_TYPE,
                    'LaTeX Preview',
                    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
                    this.webviewOptions(),
                ),
            )
        }
        this.render()
    }

    webviewOptions() {
        const roots = [
            vscode.Uri.joinPath(this.context.extensionUri, 'media'),
            ...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri),
        ]
        if (this.root) roots.push(vscode.Uri.file(path.dirname(this.root)))
        return { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: roots }
    }

    attach(panel) {
        this.panel = panel
        this.sentKeys.clear()
        panel.webview.options = this.webviewOptions()
        panel.webview.html = this.html(panel.webview)
        panel.onDidDispose(() => {
            this.panel = undefined
            this.resetAck()
        })
        panel.onDidChangeViewState(() => {
            if (panel.visible && this.stale) this.render()
        })
        panel.webview.onDidReceiveMessage(msg => this.onMessage(msg))
    }

    html(webview) {
        const nonce = crypto.randomBytes(16).toString('base64')
        const media = name => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name))
        return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${media('katex/katex.min.css')}"><link rel="stylesheet" href="${media('preview.css')}"></head>
<body><div id="toolbar"><button id="export" title="Build the PDF with LaTeX (latexmk)">Export PDF</button><span class="spacer"></span>
<button id="zoom-out" class="secondary" title="Zoom out">−</button><span id="zoom">100%</span><button id="zoom-in" class="secondary" title="Zoom in">+</button><button id="zoom-fit" class="secondary" title="Fit the page width">Fit</button></div>
<div id="doc"></div><script nonce="${nonce}" src="${media('preview.js')}"></script></body></html>`
    }

    resetAck() {
        clearTimeout(this.ackTimer)
        this.ackTimer = undefined
        this.awaitingAck = false
        this.pendingRender = false
    }

    onApplied() {
        const pending = this.pendingRender
        this.resetAck()
        if (pending) this.render()
    }

    onMessage(msg) {
        if (msg.type === 'ready') {
            this.sentKeys.clear()
            this.resetAck()
            this.render()
        } else if (msg.type === 'applied') {
            // only the ack of the update in flight releases backpressure
            if (msg.version === this.version) this.onApplied()
        } else if (msg.type === 'goto') {
            // the webview is untrusted input: only jump to files of this project, to a real line
            const file = this.files.get(normalize(String(msg.file ?? '')))
            if (!file || !Number.isInteger(msg.line) || msg.line < 0) return
            const column = Number.isInteger(msg.column) && msg.column >= 0 ? msg.column : undefined
            this.gotoSource(file, msg.line, column).catch(e => this.log.warn(`go to source failed: ${e.message}`))
        } else if (msg.type === 'painted') {
            if (!Number.isFinite(msg.at - msg.t0)) return
            this.latencies.push(msg.at - msg.t0)
            if (this.latencies.length > MAX_SAMPLES) this.latencies.shift()
        } else if (msg.type === 'export') {
            this.exportPdf().catch(e => this.log.error(`export failed: ${e.message}`))
        } else if (msg.type === 'log') {
            this.log.debug(`webview: ${String(msg.message).slice(0, 2000)}`)
        }
    }

    // ---- rendering ----

    readText(file) {
        const key = normalize(file)
        const open = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && normalize(d.uri.fsPath) === key)
        if (open) return open.getText()
        if (!this.diskText.has(key)) {
            let text
            try {
                text = fs.readFileSync(file, 'utf8')
            } catch {
                text = undefined
            }
            this.diskText.set(key, text)
        }
        return this.diskText.get(key)
    }

    onDiskChange(uri) {
        this.diskText.delete(normalize(uri.fsPath))
        if (this.files.has(normalize(uri.fsPath)) || uri.fsPath.endsWith('.bib')) this.requestRender(false)
    }

    /** An image file changed on disk: look up project images (and missing ones) again. */
    onImageChange() {
        for (const [key, image] of this.images) {
            if (!image || image.local) this.images.delete(key)
        }
        this.requestRender(false)
    }

    resolveImage(rootDir, name) {
        const cacheKey = `${rootDir}|${name}`
        this.usedImages.add(cacheKey)
        if (this.images.has(cacheKey)) return this.images.get(cacheKey)
        const candidates = path.extname(name) ? [name] : IMAGE_EXTENSIONS.map(ext => name + ext)
        const local = candidates.map(c => path.resolve(rootDir, c)).find(f => fs.existsSync(f))
        if (local) {
            this.images.set(cacheKey, this.imageResult(local, true))
            return this.images.get(cacheKey)
        }
        // Images shipped with TeX (e.g. mwe's example-image-a) live in the TeX tree. kpsewhich can take
        // seconds on a cold start, so never block a render on it: show a placeholder, re-render when found.
        // Wait until the name stops changing, so typing \includegraphics{plot} does not spawn one per letter.
        this.images.set(cacheKey, { pending: true })
        setTimeout(() => {
            if (!this.usedImages.has(cacheKey)) {
                this.images.delete(cacheKey)
                return
            }
            cp.execFile('kpsewhich', candidates, { encoding: 'utf8', timeout: 10000 }, (error, stdout) => {
                this.images.set(cacheKey, this.imageResult(stdout?.split(/\r?\n/).find(Boolean), false))
                this.requestRender(false)
            })
        }, KPSEWHICH_DELAY_MS)
        return this.images.get(cacheKey)
    }

    /** { src, version } for a displayable image, { pdf } for PDF/EPS, null when unusable. */
    imageResult(file, local) {
        if (!file) return null
        if (/\.(pdf|eps)$/i.test(file)) return { pdf: true, local }
        try {
            const stat = fs.statSync(file)
            if (!stat.isFile()) return null
            const src = this.imageSrc(file, stat)
            return src ? { src, version: `${file}:${stat.mtimeMs}`, local } : null
        } catch (e) {
            this.log.warn(`cannot read image ${file}: ${e.message}`)
            return null
        }
    }

    imageSrc(file, stat) {
        const inRoots = this.panel?.webview.options.localResourceRoots?.some(root =>
            normalize(file).startsWith(normalize(root.fsPath) + path.sep),
        )
        // the mtime query makes the webview fetch an image again after it was overwritten
        if (inRoots)
            return this.panel.webview
                .asWebviewUri(vscode.Uri.file(file))
                .with({ query: `v=${Math.round(stat.mtimeMs)}` })
                .toString()
        if (stat.size > MAX_INLINE_IMAGE_BYTES) return ''
        const type = file.endsWith('.svg') ? 'image/svg+xml' : `image/${path.extname(file).slice(1).replace('jpg', 'jpeg')}`
        return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`
    }

    /**
     * Coalesces bursts of edits: at most one render is queued, and it always reads the newest text.
     * `stamp` marks a user edit, the start of a typing-to-paint latency sample.
     */
    requestRender(stamp = true) {
        if (stamp) this.firstChangeAt ??= Date.now()
        if (this.scheduled) return
        this.scheduled = true
        setImmediate(() => {
            this.scheduled = false
            this.render()
        })
    }

    render() {
        if (!this.panel || !this.root) return
        if (!this.panel.visible) {
            this.stale = true
            return
        }
        this.stale = false
        if (this.awaitingAck) {
            // Backpressure: while the webview applies the previous update, later edits collapse into one
            // newest update instead of queueing (a slow webview would otherwise fall seconds behind).
            this.pendingRender = true
            this.ackTimer ??= setTimeout(() => this.onApplied(), ACK_TIMEOUT_MS)
            return
        }
        const t0 = this.firstChangeAt
        this.firstChangeAt = undefined
        this.usedImages = new Set()
        let result
        try {
            result = this.model.update(this.root)
        } catch (e) {
            // never leave a frozen preview: show the failure in place of the document
            this.log.error(`live preview render failed: ${e.stack ?? e}`)
            this.sentKeys.clear()
            const html = `<div class="lp-error">Live preview failed: ${escapeHtml(String(e.message))}</div>`
            void this.panel.webview.postMessage({
                type: 'update',
                version: ++this.version,
                files: [],
                blocks: [{ id: 'error', key: 'error', file: 0, line: 0, endLine: 0, html }],
            })
            return
        }
        for (const [key, image] of this.images) {
            if (!this.usedImages.has(key) && !image?.pending) this.images.delete(key) // keep only images in use
        }
        this.renderTimes.push(result.stats.ms)
        if (this.renderTimes.length > MAX_SAMPLES) this.renderTimes.shift()
        const fileList = [...new Set([...result.files, ...result.blocks.map(b => b.file)])]
        this.files = new Map(fileList.map(f => [normalize(f), f]))
        const fileIndex = new Map(fileList.map((f, i) => [f, i]))
        const blocks = result.blocks.map(b => ({
            id: b.id,
            key: b.key,
            file: fileIndex.get(b.file),
            line: b.line,
            endLine: b.endLine,
            html: this.sentKeys.has(b.key) ? undefined : b.html,
        }))
        this.sentKeys = new Set(result.blocks.map(b => b.key))
        // keep the edited line in view while typing (the webview scrolls only if it left the viewport)
        const editor = vscode.window.activeTextEditor
        const cursorFile = editor && this.files.get(normalize(editor.document.uri.fsPath))
        const cursor = cursorFile ? { file: cursorFile, line: editor.selection.active.line } : undefined
        this.awaitingAck = true
        void this.panel.webview.postMessage({
            type: 'update',
            version: ++this.version,
            t0,
            files: fileList,
            blocks,
            cursor,
            page: result.page,
        })
        this.log.trace(
            `render ${result.stats.ms.toFixed(1)} ms, parsed ${result.stats.parsed}, rendered ${result.stats.rendered}/${result.stats.blocks}`,
        )
    }

    // ---- root file ----

    async resolveRoot(document) {
        const file = document.uri.fsPath
        const text = document.getText()
        const lines = text.split(/\r?\n/)
        if (findMarkerLine(lines, '\\documentclass') >= 0) return file
        const magic = MAGIC_ROOT.exec(text)
        if (magic) return path.resolve(path.dirname(file), magic[1])
        if (this.root && this.files.has(normalize(file))) return this.root
        for (const uri of await vscode.workspace.findFiles('**/*.tex', '**/node_modules/**', 200)) {
            const candidate = readUncached(uri.fsPath)
            if (candidate === undefined || findMarkerLine(candidate.split(/\r?\n/), '\\documentclass') < 0) continue
            if (includesFile(uri.fsPath, normalize(file), [])) return uri.fsPath
        }
        return file
    }

    async onActiveEditor(editor) {
        if (!this.panel || !editor || !this.isLatex(editor.document)) return
        this.sourceColumn = editor.viewColumn
        if (this.files.has(normalize(editor.document.uri.fsPath))) return
        const seq = ++this.rootSeq
        const root = await this.resolveRoot(editor.document)
        if (seq !== this.rootSeq || !this.panel) return // a newer switch won, or the preview was closed
        if (root !== this.root) {
            this.root = root
            this.panel.webview.options = this.webviewOptions()
            this.render()
        }
    }

    // ---- sync ----

    onDocumentChange(event) {
        if (!this.panel || event.contentChanges.length === 0) return
        if (this.files.has(normalize(event.document.uri.fsPath))) this.requestRender()
    }

    onSelectionChange(event) {
        if (!this.panel || (event.kind !== Keyboard && event.kind !== Mouse)) return
        const file = this.files.get(normalize(event.textEditor.document.uri.fsPath))
        if (!file) return
        clearTimeout(this.revealTimer)
        this.revealTimer = setTimeout(() => {
            void this.panel?.webview.postMessage({ type: 'reveal', file, line: event.textEditor.selection.active.line })
        }, REVEAL_DEBOUNCE_MS)
    }

    async gotoSource(file, line, column) {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
        const visible = vscode.window.visibleTextEditors.find(e => e.document === document)
        const editor = await vscode.window.showTextDocument(document, {
            viewColumn: visible?.viewColumn ?? this.sourceColumn ?? vscode.ViewColumn.One,
            preserveFocus: false,
        })
        const target = Math.min(line, document.lineCount - 1)
        const text = document.lineAt(target)
        const position = new vscode.Position(
            target,
            column === undefined ? text.firstNonWhitespaceCharacterIndex : Math.min(column, text.text.length),
        )
        // select the clicked word (like SyncTeX's highlight); set through the API, the selection event has
        // no Keyboard/Mouse kind, so it is not echoed back to the preview
        const word = document.getWordRangeAtPosition(position)
        editor.selection = word ? new vscode.Selection(word.start, word.end) : new vscode.Selection(position, position)
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
        editor.setDecorations(this.jumpDecoration, [text.range])
        clearTimeout(this.jumpTimer)
        this.jumpTimer = setTimeout(() => editor.setDecorations(this.jumpDecoration, []), JUMP_HIGHLIGHT_MS)
        // The click that sent this jump also focused the preview, and VS Code can apply that focus after
        // the editor was shown: take the focus back once if the preview ended up active.
        await new Promise(resolve => setTimeout(resolve, REFOCUS_CHECK_MS))
        if (this.panel?.active) await vscode.window.showTextDocument(document, { viewColumn: editor.viewColumn, preserveFocus: false })
    }

    // ---- export ----

    async exportPdf() {
        const editor = vscode.window.activeTextEditor
        if (!this.root && editor && this.isLatex(editor.document)) this.root = await this.resolveRoot(editor.document)
        if (!this.root) {
            void vscode.window.showWarningMessage('Open a .tex file to export.')
            return undefined
        }
        // LaTeX Workshop builds the project of the active text editor
        const rootDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(this.root))
        await vscode.window.showTextDocument(rootDocument, { viewColumn: this.sourceColumn ?? vscode.ViewColumn.One, preserveFocus: false })
        const started = Date.now()
        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Exporting ${path.basename(this.root, '.tex')}.pdf with LaTeX…`,
                    cancellable: true,
                },
                async (progress, token) => {
                    token.onCancellationRequested(() => void vscode.commands.executeCommand('latex-workshop.kill'))
                    await vscode.commands.executeCommand('latex-workshop.build')
                },
            )
        } catch (e) {
            void vscode.window.showErrorMessage(`PDF export failed: ${e.message}`)
            throw e
        }
        // shortcut: assumes LaTeX Workshop's default output directory (next to the root file)
        const base = this.root.replace(/\.tex$/i, '')
        const pdf = `${base}.pdf`
        // latexmk leaves an up-to-date PDF untouched, so "produced" means: not older than any source
        // (LaTeX Workshop saved them all before building)
        const mtime = f => fs.statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0
        const newestSource = Math.max(0, ...[...this.files.values(), this.root].map(mtime))
        const produced = mtime(pdf) > 0 && mtime(pdf) >= newestSource - SAME_RUN_SLACK_MS
        let runLog = ''
        try {
            runLog = fs.readFileSync(`${base}.log`, 'latin1')
        } catch {
            /* no log: build did not start */
        }
        const result = { pdf, produced, errors: LOG_ERROR.test(runLog), ms: Date.now() - started }
        this.log.info(`export ${JSON.stringify(result)}`)
        this.reportExport(result).catch(e => this.log.warn(`export follow-up failed: ${e.message}`))
        return result
    }

    async reportExport({ pdf, produced, errors }) {
        const choice = !produced
            ? await vscode.window.showErrorMessage(
                  'PDF export failed: LaTeX produced no PDF. See the Problems panel.',
                  'Show Problems',
                  'Open Log',
              )
            : errors
              ? await vscode.window.showWarningMessage(
                    `Exported ${path.basename(pdf)} with LaTeX errors (see Problems).`,
                    'Open PDF',
                    'Save As…',
                    'Show Problems',
                )
              : await vscode.window.showInformationMessage(`Exported ${path.basename(pdf)}.`, 'Open PDF', 'Save As…', 'Reveal in Explorer')
        if (choice === 'Open PDF') await vscode.commands.executeCommand('latex-workshop.view')
        else if (choice === 'Show Problems') await vscode.commands.executeCommand('workbench.actions.view.problems')
        else if (choice === 'Open Log') await vscode.commands.executeCommand('latex-workshop.compilerlog')
        else if (choice === 'Reveal in Explorer') await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(pdf))
        else if (choice === 'Save As…') {
            const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(pdf), filters: { PDF: ['pdf'] } })
            if (target) await vscode.workspace.fs.copy(vscode.Uri.file(pdf), target, { overwrite: true })
        }
    }

    // ---- measurements ----

    stats() {
        const latency = [...this.latencies].sort((a, b) => a - b)
        const render = [...this.renderTimes].sort((a, b) => a - b)
        const summary = {
            samples: latency.length,
            latencyMs: { p50: percentile(latency, 50), p95: percentile(latency, 95), p99: percentile(latency, 99), max: latency.at(-1) },
            renderMs: { p50: percentile(render, 50), p95: percentile(render, 95), p99: percentile(render, 99) },
            heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
        }
        this.log.info(`live preview stats ${JSON.stringify(summary)}`)
        this.log.show(true)
        return summary
    }
}

function activatePreview(context, log, isLatex) {
    const preview = new LivePreview(context, log, isLatex)
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{tex,bib}')
    const imageWatcher = vscode.workspace.createFileSystemWatcher('**/*.{png,jpg,jpeg,gif,svg,pdf,eps}')
    context.subscriptions.push(
        watcher,
        imageWatcher,
        watcher.onDidChange(uri => preview.onDiskChange(uri)),
        watcher.onDidCreate(uri => preview.onDiskChange(uri)),
        watcher.onDidDelete(uri => preview.onDiskChange(uri)),
        imageWatcher.onDidChange(() => preview.onImageChange()),
        imageWatcher.onDidCreate(() => preview.onImageChange()),
        imageWatcher.onDidDelete(() => preview.onImageChange()),
        vscode.commands.registerCommand('latexLivePreview.open', () => preview.open()),
        vscode.commands.registerCommand('latexLivePreview.exportPdf', () => preview.exportPdf()),
        vscode.commands.registerCommand('latexLivePreview.showStats', () => preview.stats()),
        vscode.workspace.onDidChangeTextDocument(e => preview.onDocumentChange(e)),
        vscode.window.onDidChangeTextEditorSelection(e => preview.onSelectionChange(e)),
        vscode.window.onDidChangeActiveTextEditor(e => void preview.onActiveEditor(e)),
        vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
            async deserializeWebviewPanel(panel) {
                // restored after a reload: take the root from the active (or first visible) LaTeX editor
                const editor = [vscode.window.activeTextEditor, ...vscode.window.visibleTextEditors].find(e => e && isLatex(e.document))
                if (editor) preview.root = await preview.resolveRoot(editor.document)
                preview.attach(panel)
            },
        }),
    )
    return preview
}

module.exports = { activatePreview }
