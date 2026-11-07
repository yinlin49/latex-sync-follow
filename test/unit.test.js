'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { parseFdb, normalizePath } = require('../lib/fdb')

const ROOT = path.resolve('/proj')
const FDB = `# Fdb version 4
["pdflatex"] 1794055419.98956 "${ROOT.replace(/\\/g, '/')}/main.tex" "main.pdf" "main" 1794055420.472 0
  "C:/MiKTeX/tex/latex/base/article.cls" 1780057299 20144 e6010938fb17dfbae90a243ad7cf351d ""
  "main.tex" 1794015042 6542 e7e422d57cd7c54041c801c87648cf18 ""
  "sections/intro.tex" 1794015042.5 120 0123456789abcdef0123456789abcdef ""
  "missing.tex" 0 -1 0 ""
  "main.aux" 1794055420 162 55205a9e8a8eca30d36afb389b0617bf "pdflatex"
  (generated)
  "main.pdf"
["bibtex main"] 1794055421 "main.aux" "main.bbl" "main" 1794055422 0
  "refs.bib" 1794015000 300 fedcba9876543210fedcba9876543210 ""
`

test('maps relative sources to the root directory with their md5', () => {
    const map = parseFdb(FDB, path.resolve('/elsewhere'))
    assert.strictEqual(map.get(normalizePath(path.join(ROOT, 'main.tex'))), 'e7e422d57cd7c54041c801c87648cf18')
    assert.strictEqual(map.get(normalizePath(path.join(ROOT, 'sections/intro.tex'))), '0123456789abcdef0123456789abcdef')
})

test('keeps the root directory across rules with relative headers', () => {
    const map = parseFdb(FDB, path.resolve('/elsewhere'))
    assert.strictEqual(map.get(normalizePath(path.join(ROOT, 'refs.bib'))), 'fedcba9876543210fedcba9876543210')
})

test('skips missing files and generated-file lists', () => {
    const map = parseFdb(FDB, ROOT)
    assert.ok(!map.has(normalizePath(path.join(ROOT, 'missing.tex'))))
    assert.ok(!map.has(normalizePath(path.join(ROOT, 'main.pdf'))))
})

test('accepts CRLF files', () => {
    const map = parseFdb(FDB.replace(/\n/g, '\r\n'), ROOT)
    assert.strictEqual(map.get(normalizePath(path.join(ROOT, 'main.tex'))), 'e7e422d57cd7c54041c801c87648cf18')
})
