// Checks a packaged .vsix before it is released: manifest and version, the files the extension needs
// at runtime, and nothing that must not ship (sources, tests, node_modules, source maps).
// Usage: node scripts/verify-vsix.mjs <file.vsix> [--version x.y.z]
import fs from 'node:fs'
import zlib from 'node:zlib'

const REQUIRED = [
    'extension/package.json',
    'extension/extension.js',
    'extension/preview.js',
    'extension/lib/fdb.js',
    'extension/lib/latex-log.js',
    'extension/dist/renderer.js',
    'extension/media/preview.js',
    'extension/media/preview.css',
    'extension/media/katex/katex.min.css',
    'extension/readme.md',
    'extension/changelog.md',
]
const FORBIDDEN = [
    /^extension\/node_modules\//,
    /^extension\/src\//,
    /^extension\/test\//,
    /^extension\/scripts\//,
    /^extension\/\.github\//,
    /\.map$/,
    /\.vsix$/,
    /(^|\/)\.env/,
]

/** Entries of a zip file: name -> { method, compressedSize, offset } (central directory). */
function zipEntries(buffer) {
    const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    if (eocd < 0) throw new Error('not a zip file')
    const count = buffer.readUInt16LE(eocd + 10)
    let at = buffer.readUInt32LE(eocd + 16)
    const entries = new Map()
    for (let i = 0; i < count; i++) {
        if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('corrupt central directory')
        const nameLength = buffer.readUInt16LE(at + 28)
        const extraLength = buffer.readUInt16LE(at + 30)
        const commentLength = buffer.readUInt16LE(at + 32)
        const name = buffer.toString('utf8', at + 46, at + 46 + nameLength)
        entries.set(name, {
            method: buffer.readUInt16LE(at + 10),
            compressedSize: buffer.readUInt32LE(at + 20),
            offset: buffer.readUInt32LE(at + 42),
        })
        at += 46 + nameLength + extraLength + commentLength
    }
    return entries
}

function readEntry(buffer, entry) {
    const local = entry.offset
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
    const data = buffer.subarray(start, start + entry.compressedSize)
    return entry.method === 8 ? zlib.inflateRawSync(data) : data
}

const [file, flag, expectedVersion] = process.argv.slice(2)
if (!file || (flag && flag !== '--version')) {
    console.error('usage: node scripts/verify-vsix.mjs <file.vsix> [--version x.y.z]')
    process.exit(2)
}
const buffer = fs.readFileSync(file)
const entries = zipEntries(buffer)
const names = [...entries.keys()]
const problems = []
// vsce stores the readme and changelog under lower-case names
const lower = new Set(names.map(n => n.toLowerCase()))
for (const required of REQUIRED) if (!lower.has(required)) problems.push(`missing ${required}`)
if (!names.some(n => /^extension\/media\/katex\/fonts\/.+\.woff2$/.test(n))) problems.push('missing KaTeX fonts')
if (!names.some(n => /^extension\/license/i.test(n))) problems.push('missing LICENSE')
for (const name of names) if (FORBIDDEN.some(re => re.test(name))) problems.push(`must not ship ${name}`)

const manifestEntry = entries.get('extension/package.json')
const manifest = manifestEntry ? JSON.parse(readEntry(buffer, manifestEntry).toString('utf8')) : {}
if (expectedVersion && manifest.version !== expectedVersion) problems.push(`version ${manifest.version}, expected ${expectedVersion}`)
if (manifest.main && !entries.has(`extension/${manifest.main.replace(/^\.\//, '')}`)) {
    problems.push(`main ${manifest.main} is not in the package`)
}

console.log(
    `${file}: ${manifest.publisher}.${manifest.name}@${manifest.version}, ${names.length} files, ${(buffer.length / 1024).toFixed(0)} KB`,
)
if (problems.length > 0) {
    for (const problem of problems) console.error(`  ✗ ${problem}`)
    process.exit(1)
}
console.log('  ✓ manifest, version, runtime files and exclusions')
