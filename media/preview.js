// Live preview webview: keyed block reconciliation (only changed blocks touch the DOM), source<->preview sync.
;(function () {
    const vscode = acquireVsCodeApi()
    const DRAG_PX = 4 // pointer movement between mousedown and click that makes it a text selection
    const doc = document.getElementById('doc')
    const zoomLabel = document.getElementById('zoom')
    const state = vscode.getState() ?? { zoom: 'fit' }
    const htmlByKey = new Map()
    let files = []
    let lastReveal
    // Measurements read by the tests and by "Show Latency Stats": t0 = extension received the edit.
    window.__lpPaints = []

    // page box from the document (bp); 100% zoom = the PDF at 96 dpi
    let page = { width: 612, left: 72, right: 72, top: 72, fontPt: 10 }

    function applyPage(next) {
        page = next
        const em = bp => `${bp / page.fontPt}em`
        doc.style.width = em(page.width)
        doc.style.padding = `${em(page.top)} ${em(page.right)} ${em(page.top)} ${em(page.left)}`
        setZoom(state.zoom)
    }

    // 'fit' (the default, like a PDF viewer's page width) or a fixed factor chosen with +/-
    const effectiveZoom = () =>
        state.zoom === 'fit' ? Math.max(0.3, (document.documentElement.clientWidth - 24) / ((page.width * 4) / 3)) : state.zoom

    function setZoom(zoom) {
        state.zoom = zoom === 'fit' ? 'fit' : Math.min(3, Math.max(0.3, Math.round(zoom * 100) / 100))
        const factor = effectiveZoom()
        // font-size scaling (the page is laid out in em): CSS zoom breaks caretRangeFromPoint hit tests
        doc.style.fontSize = `${((page.fontPt * 4) / 3) * factor}px`
        zoomLabel.textContent = `${Math.round(factor * 100)}%`
        vscode.setState(state)
    }
    state.zoom ??= 'fit'
    setZoom(state.zoom)
    // +/- step to the next multiple of 10 %
    document.getElementById('zoom-in').onclick = () => setZoom(Math.floor(effectiveZoom() * 10 + 1e-6) / 10 + 0.1)
    document.getElementById('zoom-out').onclick = () => setZoom(Math.ceil(effectiveZoom() * 10 - 1e-6) / 10 - 0.1)
    document.getElementById('zoom-fit').onclick = () => setZoom('fit')
    window.addEventListener('resize', () => {
        if (state.zoom === 'fit') setZoom('fit')
    })
    document.getElementById('export').onclick = () => vscode.postMessage({ type: 'export' })
    window.addEventListener(
        'wheel',
        e => {
            if (!e.ctrlKey) return
            e.preventDefault()
            setZoom(effectiveZoom() - Math.sign(e.deltaY) * 0.1)
        },
        { passive: false },
    )

    function applyUpdate(msg) {
        files = msg.files
        if (msg.page && JSON.stringify(msg.page) !== JSON.stringify(page)) applyPage(msg.page)
        const ids = new Set(msg.blocks.map(b => b.id))
        const existing = new Map()
        // remove replaced blocks first, so unchanged ones line up with the walk below and are never moved
        for (const child of [...doc.children]) {
            if (ids.has(child.dataset.id)) existing.set(child.dataset.id, child)
            else child.remove()
        }
        let cursor = doc.firstElementChild
        for (const block of msg.blocks) {
            if (block.html !== undefined) htmlByKey.set(block.key, block.html)
            let node = existing.get(block.id)
            if (!node) {
                node = document.createElement('div')
                node.className = 'lp-block'
                node.dataset.id = block.id
                node.innerHTML = htmlByKey.get(block.key) ?? '<div class="lp-error">missing block</div>'
            }
            // line numbers move with edits above a block; they never require re-rendering it
            setData(node, 'file', block.file)
            setData(node, 'line', block.line)
            setData(node, 'endLine', block.endLine)
            if (node === cursor) cursor = cursor.nextElementSibling
            else doc.insertBefore(node, cursor)
        }
        const live = new Set(msg.blocks.map(b => b.key))
        for (const key of htmlByKey.keys()) if (!live.has(key)) htmlByKey.delete(key)
        vscode.postMessage({ type: 'applied', version: msg.version })
        if (msg.cursor) lastReveal = msg.cursor
        if (lastReveal) highlight(lastReveal, Boolean(msg.cursor))
        if (msg.t0) {
            requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                    const paint = { version: msg.version, t0: msg.t0, at: Date.now() }
                    window.__lpPaints.push(paint)
                    if (window.__lpPaints.length > 10000) window.__lpPaints.shift()
                    vscode.postMessage({ type: 'painted', ...paint })
                }),
            )
        }
    }

    function setData(node, name, value) {
        const text = String(value)
        if (node.dataset[name] !== text) node.dataset[name] = text
    }

    function blocksOf(fileIndex) {
        return [...doc.children].filter(b => Number(b.dataset.file) === fileIndex)
    }

    const anchorLine = (block, anchor) => Number(block.dataset.line) + Number(anchor.dataset.rl)

    /**
     * The rendered content of source `line`: from its first anchor to the next anchor of another line.
     * A line with nothing visible (\vspace, \label, \begin{itemize}) maps to the next line that has content.
     */
    function lineRange(block, line) {
        const anchors = [...block.querySelectorAll('.lp-a')]
        const range = document.createRange()
        let first = anchors.findIndex(a => anchorLine(block, a) === line)
        if (first < 0) first = anchors.findIndex(a => anchorLine(block, a) > line)
        while (first >= 0) {
            const target = anchorLine(block, anchors[first])
            const next = anchors.findIndex((a, i) => i > first && anchorLine(block, a) !== target)
            range.setStartBefore(anchors[first])
            if (next < 0) range.setEnd(block, block.childNodes.length)
            else range.setEndBefore(anchors[next])
            if (range.toString().trim() !== '' || next < 0) return range
            first = next
        }
        range.selectNodeContents(block)
        return range
    }

    /** The anchor at or before a DOM point (in document order), within `block`. */
    function anchorBefore(block, node, offset) {
        if (node.nodeType === Node.ELEMENT_NODE && offset < node.childNodes.length) node = node.childNodes[offset]
        if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('lp-a')) return node
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT, {
            acceptNode: n => (n.classList.contains('lp-a') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
        })
        walker.currentNode = node
        return walker.previousNode()
    }

    /**
     * Source line and column of a click: the anchor before the caret gives the word's position, the
     * characters between that anchor and the caret the offset inside the word.
     */
    function sourcePosition(block, e) {
        // KaTeX and images have no useful caret position: the element itself marks the spot
        const atomic = e.target.closest('.lp-math-d, .lp-math-i, img')
        const caret = atomic ? null : document.caretRangeFromPoint(e.clientX, e.clientY)
        const node = atomic ?? caret?.startContainer ?? e.target
        const offset = atomic ? 0 : (caret?.startOffset ?? 0)
        const anchor = block.contains(node) ? anchorBefore(block, node, offset) : null
        if (!anchor) return { line: Number(block.dataset.line), column: 0 }
        let inWord = 0
        if (!atomic && node.nodeType === Node.TEXT_NODE) {
            const between = document.createRange()
            between.setStartAfter(anchor)
            between.setEnd(node, offset)
            inWord = between.toString().length
        }
        const line = Math.min(anchorLine(block, anchor), Number(block.dataset.endLine))
        return { line, column: Number(anchor.dataset.c) + inWord }
    }

    function highlight(reveal, scroll) {
        const fileIndex = files.indexOf(reveal.file)
        const candidates = blocksOf(fileIndex)
        let block = candidates.find(b => Number(b.dataset.line) <= reveal.line && reveal.line <= Number(b.dataset.endLine))
        // a blank or comment line between blocks: use the nearest block above it (none in the preamble)
        block ??= candidates.filter(b => Number(b.dataset.line) <= reveal.line).pop()
        for (const b of doc.querySelectorAll('.lp-current')) b.classList.remove('lp-current')
        if (!block) {
            window.CSS?.highlights?.delete('lp-line')
            return
        }
        block.classList.add('lp-current')
        const range = lineRange(block, reveal.line)
        if (window.CSS?.highlights) CSS.highlights.set('lp-line', new Highlight(range))
        if (scroll) centerIfHidden(block, range, 2)
    }

    // Off-screen blocks are not laid out (content-visibility), so a first scroll lands on estimated
    // heights; re-measure on the next frames until the target is really in view.
    function centerIfHidden(block, range, retries) {
        const rect = range.getBoundingClientRect().height > 0 ? range.getBoundingClientRect() : block.getBoundingClientRect()
        if (rect.top >= 40 && rect.bottom <= window.innerHeight) return
        window.scrollBy({ top: rect.top - window.innerHeight / 2 + rect.height / 2, behavior: 'instant' })
        if (retries > 0) requestAnimationFrame(() => centerIfHidden(block, range, retries - 1))
    }

    // A drag selects text; a click or double-click navigates. (The selection left by an earlier
    // double-click must not block the next click, so the pointer movement decides, not the selection.)
    let pressedAt = { x: 0, y: 0 }
    doc.addEventListener('mousedown', e => {
        pressedAt = { x: e.clientX, y: e.clientY }
    })
    doc.addEventListener('click', e => {
        const moved = Math.hypot(e.clientX - pressedAt.x, e.clientY - pressedAt.y)
        const block = e.target.closest('.lp-block')
        if (moved > DRAG_PX || !block) {
            vscode.postMessage({ type: 'log', message: `click ignored: moved ${moved.toFixed(1)}px, block ${Boolean(block)}` })
            return
        }
        try {
            const { line, column } = sourcePosition(block, e)
            lastReveal = { file: files[Number(block.dataset.file)], line }
            highlight(lastReveal, false)
            vscode.postMessage({ type: 'goto', file: lastReveal.file, line, column })
        } catch (error) {
            vscode.postMessage({ type: 'log', message: `click mapping failed: ${error.stack ?? error}` })
        }
    })

    window.addEventListener('message', e => {
        const msg = e.data
        if (msg.type === 'update') applyUpdate(msg)
        else if (msg.type === 'reveal') {
            lastReveal = msg
            highlight(msg, true)
        }
    })
    vscode.postMessage({ type: 'ready' })
})()
