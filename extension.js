'use strict'
// LaTeX Live Preview: renders the project in a webview while you type, with source <-> preview navigation;
// Export PDF builds the real PDF with LaTeX Workshop on demand.
const vscode = require('vscode')
const { activatePreview } = require('./preview')

// LaTeX Workshop's LaTeX language ids
const LATEX_LANGS = ['latex', 'context', 'latex-expl3', 'pweave', 'jlweave', 'rsweave', 'doctex']
const isLatex = document => LATEX_LANGS.includes(document.languageId)

function activate(context) {
    const log = vscode.window.createOutputChannel('LaTeX Live Preview', { log: true })
    context.subscriptions.push(log)
    activatePreview(context, log, isLatex)
}

function deactivate() {}

module.exports = { activate, deactivate }
