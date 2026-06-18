# Duplicate & Corruption Finder

A fully offline, browser-based tool for finding duplicate files, flagging corrupted ones, and keeping a persistent history of everything you've scanned — all without uploading a single byte anywhere. No backend, no build step, no installation.

**Live demo:** https://tukaramhankare.github.io/Duplicate-Corruption-Finder/

## What it does

- **Finds exact duplicates** by computing a SHA-256 hash of every file's content and grouping identical matches, regardless of filename or folder.
- **Flags likely-corrupted files** using a fast magic-byte/header check against the expected file signature for common formats (images, PDFs, archives, Office documents, audio, video).
- **Remembers what it's scanned.** Every file's hash is saved to your browser's local IndexedDB, so future scans can flag files you've already processed before — even after closing the tab.
- **Deletes duplicates directly**, individually or in bulk, when your browser grants permission. Delete requires Chrome, Edge, or another Chromium-based browser.
- **Cleans up using an exported JSON database.** Re-select a folder and the tool re-verifies each file's live content hash against your imported records before allowing deletion — individually, by selection, or all at once. This step also requires a Chromium-based browser.
- **Exports everything** — scan reports as JSON or CSV, and your hash history as a standalone JSON database you can back up or move between devices.

## Getting started

No installation needed. Either:

- Open the [live version](https://tukaramhankare.github.io/Duplicate-Corruption-Finder/), or
- Clone the repo and open `index.html` directly in a browser:

```bash
git clone https://github.com/tukaramhankare/Duplicate-Corruption-Finder.git
cd Duplicate-Corruption-Finder
```

Then open `index.html` in your browser, or serve it locally:

```bash
python3 -m http.server 8000
```

and visit `http://localhost:8000`.

## How to use it

1. **Select a folder** to scan everything inside it, or **drop files** directly onto the page. Folder selection enables direct delete on Chromium browsers; dropped individual files are read-only in most cases.
2. Optionally enable MD5 (a secondary checksum, for cross-reference only — matching always uses SHA-256), header-based corruption checking, and history checking.
3. Review results across three tabs: **Duplicates** (grouped by identical content), **Flagged files** (failed the header check), and **Seen before** (matches something already in your saved history).
4. Delete what you don't need — one file at a time, by selecting several, or with "Delete selected." Delete is available on Chrome and Edge; other browsers can still export a report for manual cleanup.
5. Export a report (JSON or CSV) or export your full hash history as a portable JSON database.

## Cleaning up with an exported database

If you've exported a hash-history database (or a scan report) earlier, you can use it later to clean up a folder without re-checking everything by eye:

1. Import the JSON file from the intake panel.
2. Select the folder the records came from. Requires Chrome or Edge.
3. The tool re-hashes every file live and only marks a match "verified" if both the content hash and filename agree with the imported record.
4. Delete matches individually, by selection, or all at once with "Erase entire matches" — each path asks for confirmation first, and any file whose content changed since the check is skipped automatically rather than deleted.

## Privacy

Every operation — hashing, comparison, corruption checks, history storage — runs entirely in your browser. No file, filename, or hash is ever sent over a network. The only thing that leaves your device is whatever you choose to export.

## Built with

Plain HTML, CSS, and JavaScript. No frameworks, no build tools, no external dependencies. Hashing uses the browser's native Web Crypto API (SHA-256); MD5 is a hand-written implementation included for cross-reference purposes only. Persistent history uses IndexedDB. Folder access and direct deletion use the File System Access API.

## License

Add a license of your choice (MIT is a common pick for tools like this) and reference it here.
