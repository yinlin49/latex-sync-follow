// Bundles the ESM-only renderer (unified-latex, KaTeX) into one CommonJS file for the extension host,
// and copies KaTeX's stylesheet and fonts next to the webview assets.
import { build } from 'esbuild'
import fs from 'node:fs'

await build({
    entryPoints: ['src/preview/index.mjs'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: 'dist/renderer.js',
    minify: true,
    sourcemap: true,
    logLevel: 'warning',
})
fs.rmSync('media/katex', { recursive: true, force: true })
fs.mkdirSync('media/katex', { recursive: true })
fs.copyFileSync('node_modules/katex/dist/katex.min.css', 'media/katex/katex.min.css')
fs.cpSync('node_modules/katex/dist/fonts', 'media/katex/fonts', { recursive: true })
console.log(`dist/renderer.js ${(fs.statSync('dist/renderer.js').size / 1024).toFixed(0)} KB`)
