# Changelog

All notable changes to this extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-08

### Added

- Live Preview tab: renders the LaTeX project while you type, without building a PDF (incremental parsing with unified-latex, math with KaTeX).
- Page layout like the PDF: paper size, margins and font size from the class options and `geometry`, Computer Modern font.
- Definitions from project-local `.cls`/`.sty` files (`\newenvironment`, parameterless `\def`) and the `resume.cls` header.
- Two-way sync: cursor moves scroll and highlight the preview; clicks in the preview jump to the source line.
- Export PDF through LaTeX Workshop's build (latexmk), with Open PDF / Save As afterwards.
- SyncTeX cursor follow for the exported PDF tab, with stale-PDF detection.
- CI on Linux, Windows and macOS; tag-driven GitHub Releases with the `.vsix` and its SHA256 checksum.
