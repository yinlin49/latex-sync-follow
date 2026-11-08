# LaTeX Live Preview

[![CI](https://github.com/yinlin49/latex-sync-follow/actions/workflows/ci.yml/badge.svg)](https://github.com/yinlin49/latex-sync-follow/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/yinlin49/latex-sync-follow?include_prereleases&sort=semver)](https://github.com/yinlin49/latex-sync-follow/releases)

A VS Code companion to [LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop) (tested with 10.20.0):

- **Live Preview tab**: the document is rendered while you type, without building a PDF. A typical edit shows up in about 10 ms. The page is laid out like the PDF: paper size, margins and font size come from the document, and definitions in project-local `.cls`/`.sty` files are applied.
- **Two-way navigation**: moving the cursor in a `.tex` file scrolls the preview and highlights what that source line renders (one `\item`, not the whole list). Clicking or double-clicking a word in the preview jumps to its file, line and column and selects it.
- **Export PDF**: a real LaTeX build (latexmk through LaTeX Workshop), run only when you click the button.

## Install

Requirements:

- VS Code 1.90 or newer.
- [LaTeX Workshop](https://marketplace.visualstudio.com/items?itemName=James-Yu.latex-workshop). VS Code installs it with this extension when it is missing.
- A TeX distribution with `latexmk` (TeX Live or MiKTeX). It is needed for Export PDF only; the preview works without it.

Steps:

1. Download `latex-sync-follow-<version>.vsix` from the [latest release](https://github.com/yinlin49/latex-sync-follow/releases/latest). Optionally, check it against the `.sha256` file next to it (`sha256sum -c latex-sync-follow-<version>.vsix.sha256`).
2. In VS Code, run **Extensions: Install from VSIX…** and pick the file. From a terminal: `code --install-extension latex-sync-follow-<version>.vsix`.
3. Reload the window.

Recommended settings, with no background PDF builds and the PDF opened in a tab, are in [`latex-settings.json`](latex-settings.json). Copy them into your user settings.

## Use

1. Open the project folder and a `.tex` file. Click **Open Live Preview** (editor title bar) or run `LaTeX: Open Live Preview`.
2. Type: the preview follows. No saving is needed.
3. Click or arrow to a line: the preview scrolls there and highlights it. Click or double-click a word, a formula or an image in the preview: the editor jumps to it (the word is selected, the line flashes).
4. **Export PDF** (preview toolbar or editor title bar) runs LaTeX Workshop's build. Progress and errors appear as usual (Problems panel). Afterwards you can choose **Open PDF**, **Save As…** or **Reveal in Explorer**. The engine is the last recipe used in **LaTeX Workshop: Build with recipe** (`latexmk` for pdflatex, `latexmk (xelatex)` or `latexmk (lualatex)`).
5. Zoom: **Fit** (page width, the default), `−`/`+`, or Ctrl+mouse wheel.
6. `LaTeX: Show Live Preview Latency Stats` prints p50/p95/p99 typing-to-paint latency to the `LaTeX Live Preview` output channel.

## Why a preview instead of a live PDF

Measured with MiKTeX 26.5: one `pdflatex` pass takes 450–500 ms, even for a one-page document or with `-draftmode`. Most of that is process start-up and format loading. A full latexmk build followed by a viewer reload takes 1.5–3 s. A PDF cannot keep up with typing, so the preview renders LaTeX directly instead.

## How the preview works

- **Parser**: [unified-latex](https://github.com/siefkenj/unified-latex) (a PEG LaTeX parser with source positions), converted to HTML. Math is rendered by [KaTeX](https://katex.org).
- **Incremental**: each file is split at blank lines (a blank line ends a TeX paragraph). A chunk that leaves an environment, group or math open is merged with the following ones until it closes. Each chunk is parsed once per distinct text.
- **Block cache**: a block's HTML is cached under its text plus only the numbers it depends on (its counters, the labels it references, its citations, its images, and the macro definitions). Editing one paragraph re-parses and re-renders that paragraph only. Inserting an equation re-renders only the blocks whose numbers change.
- **Webview updates**: the webview receives HTML only for blocks it does not have yet. It replaces just those DOM nodes, so scroll position and zoom are kept. Off-screen blocks skip layout (`content-visibility`).
- **Source mapping**: before every rendered token (a word with its punctuation, a command, a formula, the text of each `\item`, the inside of `\textbf{...}`, titles and captions) the renderer places an empty anchor that carries the token's source line and column, taken from the parser's positions. A click finds the anchor just before the caret (DOM Range API) and adds the characters from the anchor to the caret, which gives the exact source column. Wrapped preview lines do not matter: positions come from the source, not the layout. Keys, paths and lengths (`\label`, `\includegraphics`, `\href` URLs, `\vspace`) get no anchors.
- **Scheduling**: renders start on the next tick after an edit. Only one update is in flight: edits made while the webview is busy collapse into one newest update, and an older render never overwrites a newer one.
- **Supported**:
    - sections (numbered), `\input`/`\include`;
    - inline and display math (`equation`, `align`, `gather`, with numbers, `\label`/`\eqref`);
    - `\newcommand`, `\newenvironment` and parameterless `\def` (also from local `.cls`/`.sty` files);
    - lists, `list` environments, `tabular`, figures and tables with numbered captions;
    - `\includegraphics` (project or TeX-tree images), `\ref`, `\cite` with a reference list from `.bib`, footnotes, `\maketitle`;
    - font commands, declarations and sizes, `\hfill` lines, `\vspace`/`\hspace`, links.
- **Fallbacks**: an unknown macro is shown in orange as `\name{args}`, with a tooltip. An unknown environment gets an "approximate: name" frame. A syntax error while typing stays inside its paragraph. Nothing is silently dropped.

## Limits

- **Preview vs PDF**: no page breaks, and list spacing is approximated. Numbers, references and text match the PDF in the tests.
- **Not rendered**: macros that need TeX internals (for example `\lipsum`, or `\@`-commands of a class) are flagged, not executed.
- **Citations** are numbered in order of first citation (like `unsrt`), not sorted (like `plain`).
- **Images**: PDF/EPS graphics show as a placeholder (they appear in the exported PDF).
- **Mapping granularity**: a source column inside a token. Inside a formula or an image, a click maps to where the formula or the image starts. Text that a macro definition produces (`\newcommand` bodies, class headers) maps to where the macro is used, or to the block start.

## Build and test from source

```sh
npm ci
npm run build          # bundle the renderer, copy KaTeX assets
npm run lint           # ESLint
npm run format:check   # Prettier
npm run typecheck      # TypeScript checks the JavaScript (JSDoc)
npm test               # unit and integration tests (node:test)
npm run package        # latex-sync-follow-<version>.vsix
npm run verify:vsix -- latex-sync-follow-<version>.vsix --version <version>
```

`npm run e2e` drives a real VS Code with Playwright and needs a TeX distribution. It checks:

- typing latency;
- edits and transient syntax errors;
- source ↔ preview navigation: double-clicks on words in every `\item`, inside and outside `\textbf`, in nested lists and in identical items, at several zoom levels, checking the line, column and selected word;
- a 2,100-line document;
- memory over repeated typing;
- Export PDF compared with the preview.

Options:

- `E2E_VSIX=latex-sync-follow-<version>.vsix` tests the installed package instead of the source tree.
- `E2E_ONLY=testItemMapping,...` runs some steps only.
- Without a local VS Code install, the suite downloads one. On Linux, run it under `xvfb-run`.

## CI and releases

- **[CI](.github/workflows/ci.yml)** runs on pushes to `main`, on pull requests, and on demand.
    - Lint, formatting, type check, unit tests, build, package and package verification run on Linux, Windows and macOS.
    - Runtime dependencies are audited.
    - The end-to-end suite runs on Linux against the packaged `.vsix`.
- **[Release](.github/workflows/release.yml)** runs when a `vX.Y.Z` tag is pushed.
    1. It checks that the tag matches `package.json`.
    2. It runs the whole CI.
    3. It creates a GitHub Release with the tested `.vsix` and its `.sha256`.
    - The notes are the matching `CHANGELOG.md` section plus the commit list.
    - Tags like `v1.2.0-beta.1` become prereleases.
    - An existing release is never replaced.

To release a new version:

1. Move the `## [Unreleased]` notes in `CHANGELOG.md` under a new `## [X.Y.Z] - YYYY-MM-DD` heading and commit them.
2. Run `npm version patch` (or `minor`, `major`, `prerelease --preid=beta`). It updates `package.json` and creates the commit and the `vX.Y.Z` tag.
3. Run `git push --follow-tags`. The release appears under Releases when CI passes.

### Publishing to the Visual Studio Marketplace and Open VSX (optional)

The release workflow publishes to the marketplaces only when you opt in:

1. Create a publisher on the [Marketplace](https://marketplace.visualstudio.com/manage) and/or a namespace on [Open VSX](https://open-vsx.org). Set `"publisher"` in `package.json` to that ID. It is `local` now, which only works for `.vsix` installs.
2. Add the repository secrets `VSCE_PAT` (Azure DevOps token, scope _Marketplace → Manage_) and/or `OVSX_PAT` (Open VSX access token).
3. Add the repository variable `PUBLISH_MARKETPLACE` = `true`.
4. Optionally, add required reviewers to the `marketplace` environment.

Stable tags are then published after the GitHub Release. Prereleases are not published.

## License

[MIT](LICENSE)
