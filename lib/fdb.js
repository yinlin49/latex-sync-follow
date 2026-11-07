'use strict'
// Reads latexmk's .fdb_latexmk: the MD5 of every source file as compiled into the current PDF/SyncTeX.
// A source whose on-disk MD5 differs from this map has changed since the last compile, so its
// SyncTeX line numbers are stale.
const path = require('path')

// ["pdflatex"] 1794055419.98 "c:/proj/main.tex" "main.pdf" "main" 1794055420.47 0
const RULE_HEADER = /^\["[^"]+"\]\s+\S+\s+"([^"]+)"/
//   "sections/intro.tex" 1794015042 6542 e7e422d57cd7c54041c801c87648cf18 ""
const SOURCE_LINE = /^\s+"([^"]+)"\s+\S+\s+\d+\s+([0-9a-f]{32})\s+"/

function normalizePath(p) {
    const resolved = path.resolve(p)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * @param {string} text content of a .fdb_latexmk file
 * @param {string} fdbDir directory holding the .fdb_latexmk, fallback base for relative paths
 * @returns {Map<string, string>} normalized absolute source path -> md5
 */
function parseFdb(text, fdbDir) {
    // Relative paths are relative to latexmk's cwd, which is the root file's directory.
    let baseDir = fdbDir
    const md5ByPath = new Map()
    for (const line of text.split(/\r?\n/)) {
        const header = RULE_HEADER.exec(line)
        if (header) {
            if (path.isAbsolute(header[1])) {
                baseDir = path.dirname(header[1])
            }
            continue
        }
        const source = SOURCE_LINE.exec(line)
        if (source) {
            md5ByPath.set(normalizePath(path.resolve(baseDir, source[1])), source[2])
        }
    }
    return md5ByPath
}

module.exports = { parseFdb, normalizePath }
