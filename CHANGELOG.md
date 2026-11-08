# Changelog

All notable changes to this extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-11-08

### Fixed

- Clicking text in the preview mapped every `\item` of a list (and text inside `\textbf`, `\emph`, section titles and captions) to the line where the list or block starts. Every word now carries its source line and column: a click jumps to that line, selects the clicked word, and briefly highlights the line. A cursor on a source line highlights exactly that line's content in the preview (one `\item`, not the whole list).

### Removed

- PDF interaction: the SyncTeX cursor-to-PDF follow, its status bar item, the `Toggle Cursor → PDF Follow` command and the `latexSyncFollow.enabled` setting. Navigation is now between the `.tex` editor and the Live Preview. Export PDF is unchanged.

## [0.1.0] - 2026-11-08

### Added

- Live Preview tab: renders the LaTeX project while you type, without building a PDF (incremental parsing with unified-latex, math with KaTeX).
- Page layout like the PDF: paper size, margins and font size from the class options and `geometry`, Computer Modern font.
- Definitions from project-local `.cls`/`.sty` files (`\newenvironment`, parameterless `\def`) and the `resume.cls` header.
- Two-way sync: cursor moves scroll and highlight the preview; clicks in the preview jump to the source line.
- Export PDF through LaTeX Workshop's build (latexmk), with Open PDF / Save As afterwards.
- SyncTeX cursor follow for the exported PDF tab, with stale-PDF detection.
- CI on Linux, Windows and macOS; tag-driven GitHub Releases with the `.vsix` and its SHA256 checksum.
