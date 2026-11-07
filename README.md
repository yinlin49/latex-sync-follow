# LaTeX Live Preview & SyncTeX Follow

A VS Code companion to [LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop) (tested with 10.20.0):

- **Live Preview tab**: the document is rendered while you type, without building a PDF. A typical edit shows up in about 10 ms.
- **Two-way sync**: moving the cursor in a `.tex` file scrolls the preview and highlights that line. Clicking in the preview jumps to the source file and line.
- **Export PDF**: a real LaTeX build (latexmk through LaTeX Workshop), run only when you click the button.
- **SyncTeX follow** for the exported PDF tab, with stale-PDF detection.

## Why a preview instead of a live PDF

Measured on this machine (MiKTeX 26.5): one `pdflatex` pass takes 450–500 ms, even for a one-page document or with `-draftmode`. Most of that is process start-up and format loading. A full latexmk build followed by a viewer reload takes 1.5–3 s. A PDF cannot keep up with typing, so the preview renders LaTeX directly instead.

## How the preview works

- **Parser**: [unified-latex](https://github.com/siefkenj/unified-latex) (a PEG LaTeX parser with source positions), converted to HTML. Math is rendered by [KaTeX](https://katex.org).
- **Incremental**: each file is split at blank lines (a blank line ends a TeX paragraph). A chunk that leaves an environment, group or math open is merged with the following ones until it closes. Each chunk is parsed once per distinct text.
- **Block cache**: a block's HTML is cached under its text plus only the numbers it depends on (its counters, the labels it references, its citations, its images, and the macro definitions). Editing one paragraph re-parses and re-renders that paragraph only. Inserting an equation re-renders only the blocks whose numbers change.
- **Webview updates**: the webview receives HTML only for blocks it does not have yet. It replaces just those DOM nodes, so scroll position and zoom are kept. Off-screen blocks skip layout (`content-visibility`).
- **Scheduling**: renders start on the next tick after an edit. Only one update is in flight: edits made while the webview is busy collapse into one newest update, and an older render never overwrites a newer one.
- **Supported**: sections (numbered), `\input`/`\include`, inline and display math (`equation`, `align`, `gather`, with numbers, `\label`/`\eqref`), `\newcommand` (text and math), lists, `tabular`, figures and tables with numbered captions, `\includegraphics` (project or TeX-tree images), `\ref`, `\cite` with a reference list from `.bib`, footnotes, `\maketitle`, font commands and declarations, links.
- **Fallbacks**: an unknown macro is shown in orange as `\name{args}`, with a tooltip. An unknown environment gets an "approximate: name" frame, its `{title}` argument as a heading, and its `\item`s as a list. A syntax error while typing stays inside its paragraph. Nothing is silently dropped.

## Use

1. Open the project folder, open a `.tex` file, click **Open Live Preview** (editor title bar) or run `LaTeX: Open Live Preview`.
2. Type: the preview follows. No saving is needed.
3. Click or arrow to a line: the preview scrolls there and highlights it. Click text, a formula, or an image in the preview: the editor jumps to that line.
4. **Export PDF** (preview toolbar or editor title bar): runs LaTeX Workshop's build. Progress and errors appear as usual (Problems panel). Afterwards you can choose **Open PDF**, **Save As…** or **Reveal in Explorer**.
5. Zoom: the `−`/`+` buttons or Ctrl+mouse wheel in the preview.
6. `LaTeX: Show Live Preview Latency Stats` prints p50/p95/p99 typing-to-paint latency to the `LaTeX SyncTeX Follow` output channel.

Engine: **LaTeX Workshop: Build with recipe** → `latexmk` (pdflatex), `latexmk (xelatex)` or `latexmk (lualatex)`. The last-used recipe is kept for exports.

## Settings

`latex-settings.json` holds the recommended user/profile settings:

- no background PDF builds (`autoBuild.run: never`);
- the PDF opens in a tab on the right;
- double-click the PDF for inverse search.

## Limits

- **Preview vs PDF**: the preview approximates the PDF layout. It has no page breaks, and fonts, spacing and float placement differ. Numbers, references and text match the PDF in the tests.
- **Not rendered**: macros from packages or document classes that the preview does not know (for example `\lipsum`, or the commands of a custom `.cls`) are flagged, not executed.
- **Citations** are numbered in order of first citation (like `unsrt`), not sorted (like `plain`).
- **Bibliography reader**: `@string` macros and `#` concatenation are not read.
- **Images**: PDF/EPS graphics show as a placeholder (they appear in the exported PDF).
- **`\input`/`\include`**: only at paragraph level. Inside other commands, the file name is shown.
- **Mapping granularity**: one source line. Within a line, clicks map to the line, not to a column.
- **SyncTeX follow** only works for latexmk recipes (it reads `.fdb_latexmk`). With XeTeX, a double-click on a table cell in the PDF can land on a nearby line of the same float. This comes from LaTeX Workshop's JavaScript SyncTeX parser.

## Tests

- `npm test`: unit tests for chunking, incremental caching, numbering, references, multi-file, anchors, fallbacks, BibTeX and `.fdb_latexmk` parsing.
- `npm run e2e:preview`: drives a separate, real VS Code with Playwright, with these steps:
  1. Open the preview and check what it renders.
  2. Type at 11 keys/s and in bursts, and measure typing-to-preview latency per key. Also measure the editor's own echo latency with the preview open and closed.
  3. Paste, delete, and edit math, a table, a heading and an image.
  4. Type unfinished `\textbf{`, `$` and `\begin{itemize}`.
  5. Check source → preview and preview → source at 70/100/150 % zoom.
  6. Repeat on a 2,100-line document with 300 equations.
  7. Check for memory growth over 450 keystrokes.
  8. Export and compare the PDF text (`pdftotext`) with the preview.
  9. Measure CPU with the preview open and closed.
- `npm run e2e`: the PDF/SyncTeX suite (auto-build, forward/inverse search, errors, xelatex, restart).
