import js from '@eslint/js'
import globals from 'globals'

export default [
    { ignores: ['dist/', 'media/katex/', 'node_modules/', '*.vsix'] },
    js.configs.recommended,
    { files: ['**/*.js'], languageOptions: { sourceType: 'commonjs', globals: globals.node } },
    { files: ['**/*.mjs'], languageOptions: { sourceType: 'module', globals: globals.node } },
    {
        // the webview script runs in the browser
        files: ['media/**/*.js'],
        languageOptions: { sourceType: 'script', globals: { ...globals.browser, acquireVsCodeApi: 'readonly' } },
    },
    {
        // end-to-end suites pass callbacks that Playwright runs inside the page
        files: ['test/**/*.js'],
        languageOptions: { globals: { ...globals.node, ...globals.browser } },
    },
    { rules: { 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }] } },
]
