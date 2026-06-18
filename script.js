"use strict";

/* ===========================================================
   FileFingerprint Scanner — script.js
   Fully client-side. No network calls, no external services.
   =========================================================== */

/* ---------- Feature detection ---------- */

const SUPPORTS_DIR_PICKER = "showDirectoryPicker" in window;
const SUPPORTS_FILE_HANDLE_DROP =
  "DataTransferItem" in window &&
  ("getAsFileSystemHandle" in DataTransferItem.prototype ||
    "webkitGetAsEntry" in DataTransferItem.prototype);
const SUPPORTS_INDEXEDDB = "indexedDB" in window;

/* ===========================================================
   INDEXEDDB HASH HISTORY STORE
   Key = sha256 + "::" + filename (so renamed-but-identical files
   are tracked as distinct entries from same-name-same-content,
   per the matching rule chosen for this build).
   =========================================================== */

const DB_NAME = "fingerprintScannerDB";
const DB_VERSION = 1;
const STORE_NAME = "hashHistory";

let dbInstance = null;

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!SUPPORTS_INDEXEDDB) {
      reject(new Error("IndexedDB not supported in this browser."));
      return;
    }
    if (dbInstance) {
      resolve(dbInstance);
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "matchKey" });
        store.createIndex("sha256", "sha256", { unique: false });
        store.createIndex("firstSeen", "firstSeen", { unique: false });
      }
    };
    req.onsuccess = (event) => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };
    req.onerror = () => reject(req.error);
  });
}

function makeMatchKey(sha256, filename) {
  return `${sha256}::${filename}`;
}

async function historyGetByMatchKey(matchKey) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(matchKey);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function historyGetBySha256(sha256) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const idx = store.index("sha256");
    const req = idx.getAll(sha256);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function historyPut(record) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function historyGetAll() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function historyCount() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => reject(req.error);
  });
}

async function historyClearAll() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/* Records a scanned file into history, unless that exact
   sha256+filename pair is already stored (keeps first-seen date). */
async function recordToHistoryIfNew(entry) {
  const matchKey = makeMatchKey(entry.sha256, entry.file.name);
  const existing = await historyGetByMatchKey(matchKey);
  if (existing) return existing; // already known — don't overwrite firstSeen
  const record = {
    matchKey,
    sha256: entry.sha256,
    filename: entry.file.name,
    size: entry.file.size,
    firstSeen: new Date().toISOString(),
  };
  await historyPut(record);
  return null; // signals "this was new, not previously seen"
}

/* ---------- App state ---------- */

const state = {
  files: [],          // [{ path, file, handle, dirHandle, canDelete }]
  hashIndex: new Map(),// sha256 -> [fileEntryIndex...]
  corrupted: [],       // [{ entryIndex, reason }]
  historyMatches: [],  // [{ entryIndex, record }] — files matching saved history
  scanning: false,
  cancelRequested: false,
  computeMD5: false,
  checkCorruption: true,
  checkHistory: true,
};

const cleanupState = {
  importedRecords: [], // parsed from uploaded JSON: [{sha256, path/filename, size}]
  folderFiles: [],      // [{ path, file, handle, dirHandle }]
  matches: [],           // [{ folderFileIndex, record, liveHash, verified }]
};

/* ---------- DOM refs ---------- */

const el = {
  browserPill: document.getElementById("browserPill"),
  navScanner: document.getElementById("navScanner"),
  navAbout: document.getElementById("navAbout"),
  scannerView: document.getElementById("scannerView"),
  aboutView: document.getElementById("aboutView"),
  pickFolderBtn: document.getElementById("pickFolderBtn"),
  dropZone: document.getElementById("dropZone"),
  fileInput: document.getElementById("fileInput"),
  optMD5: document.getElementById("optMD5"),
  optCorruption: document.getElementById("optCorruption"),
  optCheckHistory: document.getElementById("optCheckHistory"),

  historyCount: document.getElementById("historyCount"),
  historyUpdated: document.getElementById("historyUpdated"),
  viewHistoryBtn: document.getElementById("viewHistoryBtn"),
  importJsonBtn: document.getElementById("importJsonBtn"),
  jsonImportInput: document.getElementById("jsonImportInput"),

  historyPanel: document.getElementById("historyPanel"),
  closeHistoryBtn: document.getElementById("closeHistoryBtn"),
  historyTableBody: document.getElementById("historyTableBody"),
  emptyHistory: document.getElementById("emptyHistory"),
  exportHistoryBtn: document.getElementById("exportHistoryBtn"),
  clearHistoryBtn: document.getElementById("clearHistoryBtn"),

  cleanupPanel: document.getElementById("cleanupPanel"),
  closeCleanupBtn: document.getElementById("closeCleanupBtn"),
  cleanupDesc: document.getElementById("cleanupDesc"),
  cleanupPickFolderBtn: document.getElementById("cleanupPickFolderBtn"),
  cleanupResults: document.getElementById("cleanupResults"),
  cleanupEmpty: document.getElementById("cleanupEmpty"),
  cleanupToolbar: document.getElementById("cleanupToolbar"),
  cleanupSelectAll: document.getElementById("cleanupSelectAll"),
  cleanupBulkDeleteBtn: document.getElementById("cleanupBulkDeleteBtn"),
  cleanupEraseAllBtn: document.getElementById("cleanupEraseAllBtn"),

  intakePanel: document.getElementById("intakePanel"),
  progressPanel: document.getElementById("progressPanel"),
  progressLabel: document.getElementById("progressLabel"),
  progressCount: document.getElementById("progressCount"),
  progressFill: document.getElementById("progressFill"),
  progressFile: document.getElementById("progressFile"),
  cancelScanBtn: document.getElementById("cancelScanBtn"),

  summaryPanel: document.getElementById("summaryPanel"),
  statTotal: document.getElementById("statTotal"),
  statGroups: document.getElementById("statGroups"),
  statWasted: document.getElementById("statWasted"),
  statCorrupt: document.getElementById("statCorrupt"),
  exportReportBtn: document.getElementById("exportReportBtn"),
  exportCsvBtn: document.getElementById("exportCsvBtn"),
  resetBtn: document.getElementById("resetBtn"),

  resultsPanel: document.getElementById("resultsPanel"),
  tabDuplicates: document.getElementById("tabDuplicates"),
  tabCorrupted: document.getElementById("tabCorrupted"),
  tabHistoryMatches: document.getElementById("tabHistoryMatches"),
  duplicatesToolbar: document.getElementById("duplicatesToolbar"),
  bulkDeleteBtn: document.getElementById("bulkDeleteBtn"),
  duplicatesView: document.getElementById("duplicatesView"),
  corruptedView: document.getElementById("corruptedView"),
  historyMatchesView: document.getElementById("historyMatchesView"),
  emptyDuplicates: document.getElementById("emptyDuplicates"),
  emptyCorrupted: document.getElementById("emptyCorrupted"),
  emptyHistoryMatches: document.getElementById("emptyHistoryMatches"),

  toast: document.getElementById("toast"),
  infoModalOverlay: document.getElementById("infoModalOverlay"),
  infoModalBody: document.getElementById("infoModalBody"),
  infoModalClose: document.getElementById("infoModalClose"),

  confirmModalOverlay: document.getElementById("confirmModalOverlay"),
  confirmModalBody: document.getElementById("confirmModalBody"),
  confirmModalCancel: document.getElementById("confirmModalCancel"),
  confirmModalProceed: document.getElementById("confirmModalProceed"),
};

/* ---------- Browser capability pill ---------- */

function initBrowserPill() {
  if (SUPPORTS_DIR_PICKER) {
    el.browserPill.textContent = "Folder picker + delete supported";
    el.browserPill.classList.add("ok");
  } else {
    el.browserPill.textContent = "Limited browser: report-only mode (use Chrome/Edge for delete)";
    el.browserPill.classList.add("limited");
  }
}

/* ---------- Top nav: Scanner / About Us ---------- */

function switchTopNav(target) {
  const showScanner = target === "scanner";
  el.scannerView.hidden = !showScanner;
  el.aboutView.hidden = showScanner;
  el.navScanner.classList.toggle("active", showScanner);
  el.navAbout.classList.toggle("active", !showScanner);
}

el.navScanner.addEventListener("click", () => switchTopNav("scanner"));
el.navAbout.addEventListener("click", () => switchTopNav("about"));

/* ---------- Toast ---------- */

let toastTimer = null;
function showToast(msg, duration = 2600) {
  el.toast.textContent = msg;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), duration);
}

/* ---------- Info modal (delete unavailable explanation) ---------- */

function openInfoModal(message) {
  el.infoModalBody.textContent = message;
  el.infoModalOverlay.hidden = false;
}
el.infoModalClose.addEventListener("click", () => {
  el.infoModalOverlay.hidden = true;
});
el.infoModalOverlay.addEventListener("click", (e) => {
  if (e.target === el.infoModalOverlay) el.infoModalOverlay.hidden = true;
});

/* ---------- Confirm modal (yes/no, used before any Mode B delete) ---------- */

function askConfirmation(message) {
  return new Promise((resolve) => {
    el.confirmModalBody.textContent = message;
    el.confirmModalOverlay.hidden = false;

    function cleanup(result) {
      el.confirmModalOverlay.hidden = true;
      el.confirmModalProceed.removeEventListener("click", onProceed);
      el.confirmModalCancel.removeEventListener("click", onCancel);
      el.confirmModalOverlay.removeEventListener("click", onOverlay);
      resolve(result);
    }
    function onProceed() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onOverlay(e) { if (e.target === el.confirmModalOverlay) cleanup(false); }

    el.confirmModalProceed.addEventListener("click", onProceed);
    el.confirmModalCancel.addEventListener("click", onCancel);
    el.confirmModalOverlay.addEventListener("click", onOverlay);
  });
}

/* ---------- Utility: format bytes ---------- */

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/* ===========================================================
   FOLDER PICKER FLOW (File System Access API)
   =========================================================== */

el.pickFolderBtn.addEventListener("click", async () => {
  if (!SUPPORTS_DIR_PICKER) {
    openInfoModal(
      "Your browser doesn't support the folder picker API (File System Access API). " +
      "This feature currently works in Chrome, Edge, and other Chromium-based browsers. " +
      "Use the drop area instead to select individual files."
    );
    return;
  }
  try {
    const dirHandle = await window.showDirectoryPicker();
    resetWorkspace();
    showToast("Reading folder contents…");
    const entries = await collectFilesFromDirectory(dirHandle, dirHandle.name);
    if (entries.length === 0) {
      showToast("That folder appears to be empty.");
      return;
    }
    state.files = entries;
    await runScan();
  } catch (err) {
    if (err && err.name === "AbortError") return; // user cancelled picker
    console.error(err);
    showToast("Couldn't read that folder. It may be a protected system location.");
  }
});

async function collectFilesFromDirectory(dirHandle, basePath) {
  const results = [];
  async function walk(handle, path) {
    for await (const [name, entryHandle] of handle.entries()) {
      const entryPath = `${path}/${name}`;
      if (entryHandle.kind === "file") {
        try {
          const file = await entryHandle.getFile();
          results.push({
            path: entryPath,
            file,
            handle: entryHandle,
            dirHandle: handle,
            canDelete: true,
          });
        } catch (e) {
          // unreadable file, skip silently
        }
      } else if (entryHandle.kind === "directory") {
        await walk(entryHandle, entryPath);
      }
    }
  }
  await walk(dirHandle, basePath);
  return results;
}

/* ===========================================================
   DRAG AND DROP / FILE INPUT FLOW
   =========================================================== */

el.dropZone.addEventListener("click", () => el.fileInput.click());

el.fileInput.addEventListener("change", async (e) => {
  const fileList = Array.from(e.target.files || []);
  if (fileList.length === 0) return;
  resetWorkspace();
  state.files = fileList.map((file) => ({
    path: file.webkitRelativePath || file.name,
    file,
    handle: null,
    dirHandle: null,
    canDelete: false,
  }));
  await runScan();
  el.fileInput.value = "";
});

["dragenter", "dragover"].forEach((evt) => {
  el.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropZone.classList.add("drag-over");
  });
});

["dragleave", "drop"].forEach((evt) => {
  el.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropZone.classList.remove("drag-over");
  });
});

el.dropZone.addEventListener("drop", async (e) => {
  const items = e.dataTransfer.items;
  if (!items || items.length === 0) return;

  resetWorkspace();
  showToast("Reading dropped items…");

  const collected = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== "file") continue;

    if ("getAsFileSystemHandle" in item) {
      try {
        const handle = await item.getAsFileSystemHandle();
        if (handle) await collectFromHandle(handle, handle.name, collected);
        continue;
      } catch (err) {
        // fall through to legacy entry API
      }
    }
    if ("webkitGetAsEntry" in item) {
      const entry = item.webkitGetAsEntry();
      if (entry) {
        await collectFromEntry(entry, entry.name, collected);
        continue;
      }
    }
    // last resort: plain getAsFile, no handle, no delete capability
    const plain = item.getAsFile();
    if (plain) {
      collected.push({
        path: plain.name,
        file: plain,
        handle: null,
        dirHandle: null,
        canDelete: false,
      });
    }
  }

  if (collected.length === 0) {
    showToast("Couldn't read any files from that drop.");
    return;
  }

  state.files = collected;
  await runScan();
});

// Modern handle-based traversal (Chromium drag-and-drop of folders)
async function collectFromHandle(handle, path, out) {
  if (handle.kind === "file") {
    try {
      const file = await handle.getFile();
      out.push({ path, file, handle, dirHandle: null, canDelete: true });
    } catch (e) {
      /* skip unreadable */
    }
  } else if (handle.kind === "directory") {
    for await (const [name, child] of handle.entries()) {
      await collectFromHandle(child, `${path}/${name}`, out);
    }
  }
}

// Legacy webkitGetAsEntry traversal (Firefox / Safari folder drops)
function collectFromEntry(entry, path, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(
        (file) => {
          out.push({ path, file, handle: null, dirHandle: null, canDelete: false });
          resolve();
        },
        () => resolve()
      );
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const allEntries = [];
      function readBatch() {
        reader.readEntries(async (batch) => {
          if (batch.length === 0) {
            for (const child of allEntries) {
              await collectFromEntry(child, `${path}/${child.name}`, out);
            }
            resolve();
            return;
          }
          allEntries.push(...batch);
          readBatch();
        }, () => resolve());
      }
      readBatch();
    } else {
      resolve();
    }
  });
}

/* ===========================================================
   HASHING (Web Crypto API — SHA-256, optional MD5)
   =========================================================== */

async function sha256File(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return bufferToHex(digest);
}

function bufferToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/* Minimal, self-contained MD5 implementation (RFC 1321).
   Used only as an optional secondary/cross-check value; all
   duplicate matching uses SHA-256. No external library used. */
function md5(arrayBuffer) {
  function rotl(x, c) { return (x << c) | (x >>> (32 - c)); }
  function toHexLE(num) {
    let hex = "";
    for (let i = 0; i < 4; i++) {
      hex += ((num >> (i * 8)) & 0xff).toString(16).padStart(2, "0");
    }
    return hex;
  }

  const K = new Int32Array([
    0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,
    0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,
    0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,
    0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,
    0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,
    0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,
    0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,
    0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391
  ]);
  const S = [
    7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
    5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
    4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
    6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21
  ];

  const bytes = new Uint8Array(arrayBuffer);
  const origLenBits = bytes.length * 8;

  let withOne = new Uint8Array(((bytes.length + 8) >> 6) * 64 + 64);
  withOne.set(bytes);
  withOne[bytes.length] = 0x80;
  const totalLen = withOne.length;
  const lenLow = origLenBits >>> 0;
  const lenHigh = Math.floor(origLenBits / 0x100000000) >>> 0;
  withOne[totalLen - 8] = lenLow & 0xff;
  withOne[totalLen - 7] = (lenLow >>> 8) & 0xff;
  withOne[totalLen - 6] = (lenLow >>> 16) & 0xff;
  withOne[totalLen - 5] = (lenLow >>> 24) & 0xff;
  withOne[totalLen - 4] = lenHigh & 0xff;
  withOne[totalLen - 3] = (lenHigh >>> 8) & 0xff;
  withOne[totalLen - 2] = (lenHigh >>> 16) & 0xff;
  withOne[totalLen - 1] = (lenHigh >>> 24) & 0xff;

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  const view = new DataView(withOne.buffer);
  const chunkCount = withOne.length / 64;

  for (let chunk = 0; chunk < chunkCount; chunk++) {
    const M = new Int32Array(16);
    for (let j = 0; j < 16; j++) {
      M[j] = view.getInt32(chunk * 64 + j * 4, true);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, S[i])) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  return toHexLE(a0) + toHexLE(b0) + toHexLE(c0) + toHexLE(d0);
}

/* ===========================================================
   CORRUPTION CHECK — magic byte / header validation
   =========================================================== */

const SIGNATURES = [
  { ext: ["png"], bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: ["jpg", "jpeg"], bytes: [0xff, 0xd8, 0xff] },
  { ext: ["gif"], bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: ["pdf"], bytes: [0x25, 0x50, 0x44, 0x46] },
  { ext: ["zip", "docx", "xlsx", "pptx", "apk", "jar"], bytes: [0x50, 0x4b, 0x03, 0x04] },
  { ext: ["gz"], bytes: [0x1f, 0x8b] },
  { ext: ["rar"], bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
  { ext: ["7z"], bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { ext: ["bmp"], bytes: [0x42, 0x4d] },
  { ext: ["webp"], bytes: [0x52, 0x49, 0x46, 0x46], offsetCheck: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
  { ext: ["mp3"], bytes: [0x49, 0x44, 0x33] }, // ID3 tag; not all mp3s have it
  { ext: ["mp4", "mov", "m4a", "m4v"], bytes: [], boxCheck: true }, // checked via ftyp box
];

function getExt(filename) {
  const idx = filename.lastIndexOf(".");
  if (idx === -1) return "";
  return filename.slice(idx + 1).toLowerCase();
}

async function checkCorruption(file) {
  const ext = getExt(file.name);
  const known = SIGNATURES.filter((s) => s.ext.includes(ext));
  if (known.length === 0) return null; // no signature on file for this type, skip

  const headerSize = 16;
  const headerBuf = await file.slice(0, headerSize).arrayBuffer();
  const header = new Uint8Array(headerBuf);

  if (file.size === 0) {
    return "File is zero bytes — empty or fully truncated.";
  }

  for (const sig of known) {
    if (sig.boxCheck) {
      // mp4/mov family: look for 'ftyp' box marker within first 16 bytes
      const text = Array.from(header.slice(4, 8)).map((b) => String.fromCharCode(b)).join("");
      if (text === "ftyp") return null;
      continue;
    }
    if (matchesBytes(header, sig.bytes)) {
      if (sig.offsetCheck) {
        const offBuf = await file.slice(sig.offsetCheck.offset, sig.offsetCheck.offset + sig.offsetCheck.bytes.length).arrayBuffer();
        const offBytes = new Uint8Array(offBuf);
        if (matchesBytes(offBytes, sig.offsetCheck.bytes)) return null;
        continue;
      }
      return null; // header matches expected signature, looks fine
    }
  }

  return `File extension is .${ext} but the file header doesn't match the expected signature for that type.`;
}

function matchesBytes(actual, expected) {
  if (expected.length === 0) return false;
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

/* ===========================================================
   SCAN ORCHESTRATION
   =========================================================== */

function resetWorkspace() {
  state.files = [];
  state.hashIndex = new Map();
  state.corrupted = [];
  state.historyMatches = [];
  state.cancelRequested = false;

  el.summaryPanel.hidden = true;
  el.resultsPanel.hidden = true;
  el.duplicatesView.innerHTML = "";
  el.corruptedView.innerHTML = "";
  el.historyMatchesView.innerHTML = "";
  el.emptyDuplicates.hidden = true;
  el.emptyCorrupted.hidden = true;
  el.emptyHistoryMatches.hidden = true;
}

el.resetBtn.addEventListener("click", () => {
  resetWorkspace();
  el.progressPanel.hidden = true;
  el.intakePanel.hidden = false;
});

el.cancelScanBtn.addEventListener("click", () => {
  state.cancelRequested = true;
});

async function runScan() {
  state.computeMD5 = el.optMD5.checked;
  state.checkCorruption = el.optCorruption.checked;
  state.checkHistory = el.optCheckHistory.checked && SUPPORTS_INDEXEDDB;
  state.scanning = true;
  state.cancelRequested = false;

  el.intakePanel.hidden = true;
  el.progressPanel.hidden = false;
  el.progressLabel.textContent = "Scanning files…";

  const total = state.files.length;
  const sha256Map = new Map(); // hash -> [index]

  for (let i = 0; i < total; i++) {
    if (state.cancelRequested) {
      showToast("Scan cancelled.");
      break;
    }

    const entry = state.files[i];
    el.progressFile.textContent = entry.path;
    el.progressCount.textContent = `${i + 1} / ${total}`;
    el.progressFill.style.width = `${Math.round(((i + 1) / total) * 100)}%`;

    try {
      const hash = await sha256File(entry.file);
      entry.sha256 = hash;
      if (!sha256Map.has(hash)) sha256Map.set(hash, []);
      sha256Map.get(hash).push(i);

      if (state.computeMD5) {
        const buf = await entry.file.arrayBuffer();
        entry.md5 = md5(buf);
      }

      if (state.checkCorruption) {
        const issue = await checkCorruption(entry.file);
        if (issue) {
          state.corrupted.push({ entryIndex: i, reason: issue });
        }
      }

      if (state.checkHistory) {
        try {
          const matchKey = makeMatchKey(hash, entry.file.name);
          const existingRecord = await historyGetByMatchKey(matchKey);
          if (existingRecord) {
            state.historyMatches.push({ entryIndex: i, record: existingRecord });
          }
          // Always record this scan into history (first-seen preserved if it already existed)
          await recordToHistoryIfNew(entry);
        } catch (histErr) {
          console.error("History DB error for", entry.path, histErr);
        }
      }
    } catch (err) {
      console.error("Error processing", entry.path, err);
      state.corrupted.push({ entryIndex: i, reason: "Could not be read or processed (possibly locked or unreadable)." });
    }

    // Yield to the browser so UI stays responsive on large batches
    if (i % 8 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // keep only groups with more than one file
  for (const [hash, indices] of sha256Map.entries()) {
    if (indices.length > 1) state.hashIndex.set(hash, indices);
  }

  state.scanning = false;
  el.progressPanel.hidden = true;
  renderResults();
  refreshHistoryBar();
}

/* ===========================================================
   RENDERING
   =========================================================== */

function renderResults() {
  el.summaryPanel.hidden = false;
  el.resultsPanel.hidden = false;
  switchResultsTab("duplicates");

  const totalFiles = state.files.length;
  const groupCount = state.hashIndex.size;

  let wastedBytes = 0;
  for (const indices of state.hashIndex.values()) {
    const sizes = indices.map((i) => state.files[i].file.size);
    const sorted = [...sizes].sort((a, b) => b - a);
    wastedBytes += sorted.slice(1).reduce((a, b) => a + b, 0);
  }

  el.statTotal.textContent = totalFiles.toLocaleString();
  el.statGroups.textContent = groupCount.toLocaleString();
  el.statWasted.textContent = formatBytes(wastedBytes);
  el.statCorrupt.textContent = state.corrupted.length.toLocaleString();

  renderDuplicates();
  renderCorrupted();
  renderHistoryMatches();
  updateBulkDeleteState();
}

function renderDuplicates() {
  el.duplicatesView.innerHTML = "";

  if (state.hashIndex.size === 0) {
    el.emptyDuplicates.hidden = false;
    return;
  }
  el.emptyDuplicates.hidden = true;

  for (const [hash, indices] of state.hashIndex.entries()) {
    const group = document.createElement("div");
    group.className = "fp-group";
    group.dataset.hash = hash;

    const head = document.createElement("div");
    head.className = "fp-group-head";

    const tag = document.createElement("span");
    tag.className = "fp-hash-tag";
    tag.textContent = `sha256:${hash.slice(0, 16)}…`;
    tag.title = hash;

    const meta = document.createElement("span");
    meta.className = "fp-group-meta";
    meta.textContent = `${indices.length} identical files`;

    head.appendChild(tag);
    head.appendChild(meta);
    group.appendChild(head);

    // Keep the file with the longest path string as "original" by default
    // (heuristic only — visually marked, not enforced)
    const keepIndex = indices.reduce((best, cur) =>
      state.files[cur].path.length >= state.files[best].path.length ? cur : best
    );

    indices.forEach((fileIndex) => {
      const entry = state.files[fileIndex];
      const row = document.createElement("div");
      row.className = "fp-file-row" + (fileIndex === keepIndex ? " keep" : "");

      const isKeep = fileIndex === keepIndex;

      if (!isKeep) {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "dup-select";
        cb.dataset.fileIndex = String(fileIndex);
        cb.addEventListener("change", updateBulkDeleteState);
        row.appendChild(cb);
      } else {
        const spacer = document.createElement("span");
        spacer.style.width = "16px";
        spacer.style.display = "inline-block";
        row.appendChild(spacer);
      }

      const info = document.createElement("div");
      info.className = "fp-file-info";

      const pathEl = document.createElement("div");
      pathEl.className = "fp-file-path";
      pathEl.textContent = entry.path;
      pathEl.title = entry.path;

      const subEl = document.createElement("div");
      subEl.className = "fp-file-sub";
      const modDate = entry.file.lastModified ? new Date(entry.file.lastModified).toLocaleDateString() : "unknown date";
      subEl.textContent = `${formatBytes(entry.file.size)} · modified ${modDate}${entry.canDelete ? "" : " · no delete handle"}`;

      info.appendChild(pathEl);
      info.appendChild(subEl);
      row.appendChild(info);

      if (isKeep) {
        const badge = document.createElement("span");
        badge.className = "fp-keep-badge";
        badge.textContent = "Keeping";
        row.appendChild(badge);
      } else {
        const actions = document.createElement("div");
        actions.className = "fp-row-actions";
        const delBtn = document.createElement("button");
        delBtn.className = "btn-small danger";
        delBtn.textContent = "Delete";
        delBtn.addEventListener("click", () => handleSingleDelete(fileIndex, row, group));
        actions.appendChild(delBtn);
        row.appendChild(actions);
      }

      group.appendChild(row);
    });

    el.duplicatesView.appendChild(group);
  }
}

function renderCorrupted() {
  el.corruptedView.innerHTML = "";

  if (state.corrupted.length === 0) {
    el.emptyCorrupted.hidden = false;
    return;
  }
  el.emptyCorrupted.hidden = true;

  state.corrupted.forEach(({ entryIndex, reason }) => {
    const entry = state.files[entryIndex];
    const row = document.createElement("div");
    row.className = "corrupt-row";

    const icon = document.createElement("span");
    icon.className = "corrupt-icon";
    icon.textContent = "⚠";

    const info = document.createElement("div");
    info.className = "corrupt-info";

    const pathEl = document.createElement("div");
    pathEl.className = "corrupt-path";
    pathEl.textContent = entry.path;

    const reasonEl = document.createElement("div");
    reasonEl.className = "corrupt-reason";
    reasonEl.textContent = reason;

    info.appendChild(pathEl);
    info.appendChild(reasonEl);

    const delBtn = document.createElement("button");
    delBtn.className = "btn-small danger";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => handleSingleDelete(entryIndex, row, null));

    row.appendChild(icon);
    row.appendChild(info);
    row.appendChild(delBtn);

    el.corruptedView.appendChild(row);
  });
}

function renderHistoryMatches() {
  el.historyMatchesView.innerHTML = "";

  if (state.historyMatches.length === 0) {
    el.emptyHistoryMatches.hidden = false;
    return;
  }
  el.emptyHistoryMatches.hidden = true;

  state.historyMatches.forEach(({ entryIndex, record }) => {
    const entry = state.files[entryIndex];
    const row = document.createElement("div");
    row.className = "corrupt-row";

    const icon = document.createElement("span");
    icon.className = "corrupt-icon";
    icon.style.color = "var(--accent-dark)";
    icon.textContent = "🕓";

    const info = document.createElement("div");
    info.className = "corrupt-info";

    const pathEl = document.createElement("div");
    pathEl.className = "corrupt-path";
    pathEl.textContent = entry.path;

    const reasonEl = document.createElement("div");
    reasonEl.className = "corrupt-reason";
    reasonEl.style.color = "var(--ink-soft)";
    const firstSeenDate = new Date(record.firstSeen).toLocaleDateString();
    reasonEl.textContent = `Matches a file first scanned on ${firstSeenDate} (same name and content).`;

    info.appendChild(pathEl);
    info.appendChild(reasonEl);

    const delBtn = document.createElement("button");
    delBtn.className = "btn-small danger";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => handleSingleDelete(entryIndex, row, null));

    row.appendChild(icon);
    row.appendChild(info);
    row.appendChild(delBtn);

    el.historyMatchesView.appendChild(row);
  });
}

/* ---------- Tabs ---------- */

const TAB_BUTTONS = {
  duplicates: el.tabDuplicates,
  corrupted: el.tabCorrupted,
  history: el.tabHistoryMatches,
};
const TAB_VIEWS = {
  duplicates: el.duplicatesView,
  corrupted: el.corruptedView,
  history: el.historyMatchesView,
};

function switchResultsTab(activeKey) {
  for (const key of Object.keys(TAB_BUTTONS)) {
    const isActive = key === activeKey;
    TAB_BUTTONS[key].classList.toggle("active", isActive);
    TAB_VIEWS[key].hidden = !isActive;
  }
  el.duplicatesToolbar.hidden = activeKey !== "duplicates";
}

el.tabDuplicates.addEventListener("click", () => switchResultsTab("duplicates"));
el.tabCorrupted.addEventListener("click", () => switchResultsTab("corrupted"));
el.tabHistoryMatches.addEventListener("click", () => switchResultsTab("history"));

/* ===========================================================
   DELETE HANDLING
   =========================================================== */

const DELETE_UNAVAILABLE_MSG =
  "This file doesn't have a removable handle in this browser/mode. " +
  "Chrome and Edge support deleting files you reach through the folder picker. " +
  "Files added by drag-and-drop or in Firefox/Safari are read-only here — " +
  "use the exported report to delete them manually in your file manager.";

async function handleSingleDelete(fileIndex, rowEl, groupEl) {
  const entry = state.files[fileIndex];

  if (!entry.canDelete || !entry.handle) {
    openInfoModal(DELETE_UNAVAILABLE_MSG);
    return;
  }

  try {
    if (entry.dirHandle && entry.dirHandle.removeEntry) {
      const name = entry.handle.name;
      await entry.dirHandle.removeEntry(name);
    } else if (entry.handle.remove) {
      await entry.handle.remove();
    } else {
      openInfoModal(DELETE_UNAVAILABLE_MSG);
      return;
    }
    entry.deleted = true;
    rowEl.remove();
    showToast(`Deleted ${entry.path.split("/").pop()}`);

    if (groupEl) {
      const remaining = groupEl.querySelectorAll(".fp-file-row").length;
      if (remaining <= 1) groupEl.remove();
    }
    refreshStatsAfterDelete();
  } catch (err) {
    console.error(err);
    showToast("Delete failed — the file may be in use or permission was revoked.");
  }
}

el.bulkDeleteBtn.addEventListener("click", async () => {
  const checked = Array.from(document.querySelectorAll(".dup-select:checked"));
  if (checked.length === 0) return;

  let deletedCount = 0;
  let blockedCount = 0;

  for (const cb of checked) {
    const fileIndex = Number(cb.dataset.fileIndex);
    const entry = state.files[fileIndex];
    const row = cb.closest(".fp-file-row");
    const group = cb.closest(".fp-group");

    if (!entry.canDelete || !entry.handle) {
      blockedCount++;
      continue;
    }

    try {
      if (entry.dirHandle && entry.dirHandle.removeEntry) {
        await entry.dirHandle.removeEntry(entry.handle.name);
      } else if (entry.handle.remove) {
        await entry.handle.remove();
      } else {
        blockedCount++;
        continue;
      }
      entry.deleted = true;
      row.remove();
      deletedCount++;
      if (group && group.querySelectorAll(".fp-file-row").length <= 1) group.remove();
    } catch (err) {
      console.error(err);
      blockedCount++;
    }
  }

  refreshStatsAfterDelete();
  updateBulkDeleteState();

  if (deletedCount > 0) showToast(`Deleted ${deletedCount} file${deletedCount > 1 ? "s" : ""}.`);
  if (blockedCount > 0) {
    openInfoModal(
      `${blockedCount} of the selected files couldn't be deleted because they lack a removable handle. ` + DELETE_UNAVAILABLE_MSG
    );
  }
});

function updateBulkDeleteState() {
  const anyChecked = document.querySelectorAll(".dup-select:checked").length > 0;
  el.bulkDeleteBtn.disabled = !anyChecked;
}

function refreshStatsAfterDelete() {
  const remainingFiles = state.files.filter((f) => !f.deleted);
  el.statTotal.textContent = remainingFiles.length.toLocaleString();

  let groupCount = 0;
  let wastedBytes = 0;
  for (const indices of state.hashIndex.values()) {
    const alive = indices.filter((i) => !state.files[i].deleted);
    if (alive.length > 1) {
      groupCount++;
      const sizes = alive.map((i) => state.files[i].file.size).sort((a, b) => b - a);
      wastedBytes += sizes.slice(1).reduce((a, b) => a + b, 0);
    }
  }
  el.statGroups.textContent = groupCount.toLocaleString();
  el.statWasted.textContent = formatBytes(wastedBytes);
}

/* ===========================================================
   EXPORTS
   =========================================================== */

function buildReportData() {
  const duplicateGroups = [];
  for (const [hash, indices] of state.hashIndex.entries()) {
    duplicateGroups.push({
      sha256: hash,
      files: indices.map((i) => ({
        path: state.files[i].path,
        size: state.files[i].file.size,
        md5: state.files[i].md5 || null,
      })),
    });
  }

  const flagged = state.corrupted.map(({ entryIndex, reason }) => ({
    path: state.files[entryIndex].path,
    size: state.files[entryIndex].file.size,
    reason,
  }));

  return {
    generatedAt: new Date().toISOString(),
    totalFilesScanned: state.files.length,
    duplicateGroups,
    flaggedFiles: flagged,
  };
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

el.exportReportBtn.addEventListener("click", () => {
  const report = buildReportData();
  downloadBlob(JSON.stringify(report, null, 2), "fingerprint-report.json", "application/json");
  showToast("Report exported as JSON.");
});

el.exportCsvBtn.addEventListener("click", () => {
  const report = buildReportData();
  const rows = [["type", "group_hash", "path", "size_bytes", "reason"]];

  report.duplicateGroups.forEach((g) => {
    g.files.forEach((f) => {
      rows.push(["duplicate", g.sha256, f.path, String(f.size), ""]);
    });
  });
  report.flaggedFiles.forEach((f) => {
    rows.push(["flagged", "", f.path, String(f.size), f.reason]);
  });

  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\r\n");

  downloadBlob(csv, "fingerprint-report.csv", "text/csv");
  showToast("Report exported as CSV.");
});

/* ===========================================================
   HISTORY BAR (intake panel summary of saved IndexedDB state)
   =========================================================== */

async function refreshHistoryBar() {
  if (!SUPPORTS_INDEXEDDB) {
    el.historyCount.textContent = "0";
    el.historyUpdated.textContent = "History storage isn't available in this browser.";
    el.viewHistoryBtn.disabled = true;
    el.importJsonBtn.disabled = false; // import/cleanup mode doesn't require IndexedDB
    return;
  }
  try {
    const count = await historyCount();
    el.historyCount.textContent = count.toLocaleString();
    if (count > 0) {
      const all = await historyGetAll();
      const latest = all.reduce((max, r) => (r.firstSeen > max ? r.firstSeen : max), all[0].firstSeen);
      el.historyUpdated.textContent = `Last updated ${new Date(latest).toLocaleDateString()}`;
    } else {
      el.historyUpdated.textContent = "";
    }
  } catch (err) {
    console.error(err);
    el.historyUpdated.textContent = "Couldn't read history.";
  }
}

/* ===========================================================
   HISTORY PANEL (view / export / clear saved hashes)
   =========================================================== */

el.viewHistoryBtn.addEventListener("click", async () => {
  el.historyPanel.hidden = false;
  await renderHistoryTable();
});

el.closeHistoryBtn.addEventListener("click", () => {
  el.historyPanel.hidden = true;
});

async function renderHistoryTable() {
  el.historyTableBody.innerHTML = "";
  if (!SUPPORTS_INDEXEDDB) {
    el.emptyHistory.hidden = false;
    el.emptyHistory.textContent = "History storage isn't available in this browser.";
    return;
  }
  const all = await historyGetAll();
  if (all.length === 0) {
    el.emptyHistory.hidden = false;
    return;
  }
  el.emptyHistory.hidden = true;

  all
    .sort((a, b) => (a.firstSeen < b.firstSeen ? 1 : -1))
    .forEach((record) => {
      const tr = document.createElement("tr");

      const tdName = document.createElement("td");
      tdName.textContent = record.filename;
      tdName.title = record.filename;

      const tdHash = document.createElement("td");
      tdHash.textContent = record.sha256.slice(0, 20) + "…";
      tdHash.title = record.sha256;

      const tdSize = document.createElement("td");
      tdSize.textContent = formatBytes(record.size);

      const tdDate = document.createElement("td");
      tdDate.textContent = new Date(record.firstSeen).toLocaleDateString();

      tr.appendChild(tdName);
      tr.appendChild(tdHash);
      tr.appendChild(tdSize);
      tr.appendChild(tdDate);
      el.historyTableBody.appendChild(tr);
    });
}

el.exportHistoryBtn.addEventListener("click", async () => {
  if (!SUPPORTS_INDEXEDDB) {
    showToast("No history available to export.");
    return;
  }
  const all = await historyGetAll();
  if (all.length === 0) {
    showToast("History is empty — nothing to export.");
    return;
  }
  const payload = {
    exportType: "fingerprintScannerHashDatabase",
    exportedAt: new Date().toISOString(),
    recordCount: all.length,
    records: all.map((r) => ({
      sha256: r.sha256,
      filename: r.filename,
      size: r.size,
      firstSeen: r.firstSeen,
    })),
  };
  downloadBlob(JSON.stringify(payload, null, 2), "hash-history-database.json", "application/json");
  showToast(`Exported ${all.length.toLocaleString()} records.`);
});

el.clearHistoryBtn.addEventListener("click", async () => {
  const confirmed = await askConfirmation(
    "This permanently deletes every saved hash record on this device. It does not touch any of your actual files — only the memory of having seen them. This can't be undone unless you've exported a backup."
  );
  if (!confirmed) return;
  await historyClearAll();
  await renderHistoryTable();
  await refreshHistoryBar();
  showToast("History cleared.");
});

/* ===========================================================
   MODE B: IMPORT JSON + CLEAN UP A LIVE FOLDER
   =========================================================== */

el.importJsonBtn.addEventListener("click", () => {
  el.jsonImportInput.click();
});

el.jsonImportInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const records = normalizeImportedRecords(parsed);
    if (records.length === 0) {
      showToast("That JSON file doesn't contain any recognizable hash records.");
      return;
    }
    cleanupState.importedRecords = records;
    cleanupState.folderFiles = [];
    cleanupState.matches = [];
    el.cleanupResults.innerHTML = "";
    el.cleanupEmpty.hidden = true;
    el.cleanupDesc.textContent =
      `Loaded ${records.length.toLocaleString()} record${records.length === 1 ? "" : "s"} from "${file.name}". ` +
      `Select the folder these files came from to check for matches.`;
    el.cleanupPanel.hidden = false;
  } catch (err) {
    console.error(err);
    showToast("Couldn't read that file as JSON. Use a report exported from this tool.");
  }
  el.jsonImportInput.value = "";
});

// Accepts either the full scan report format (duplicateGroups/flaggedFiles)
// or the dedicated hash-history-database export format.
function normalizeImportedRecords(parsed) {
  const out = [];
  if (!parsed || typeof parsed !== "object") return out;

  if (Array.isArray(parsed.records)) {
    // hash-history-database.json format
    for (const r of parsed.records) {
      if (r && r.sha256 && r.filename) {
        out.push({ sha256: r.sha256, filename: r.filename, size: r.size || null });
      }
    }
  }
  if (Array.isArray(parsed.duplicateGroups)) {
    // fingerprint-report.json format
    for (const group of parsed.duplicateGroups) {
      if (!group) continue;
      for (const f of group.files || []) {
        if (group.sha256 && f && f.path) {
          const filename = f.path.split("/").pop();
          out.push({ sha256: group.sha256, filename, size: f.size || null, fullPath: f.path });
        }
      }
    }
  }
  return out;
}

el.closeCleanupBtn.addEventListener("click", () => {
  el.cleanupPanel.hidden = true;
});

el.cleanupPickFolderBtn.addEventListener("click", async () => {
  if (!SUPPORTS_DIR_PICKER) {
    openInfoModal(
      "Cleaning up using an imported JSON file requires the folder picker, which this browser doesn't support. " +
      "Use Chrome or Edge for this feature."
    );
    return;
  }
  try {
    const dirHandle = await window.showDirectoryPicker();
    showToast("Reading folder and checking against imported records…");
    const entries = await collectFilesFromDirectory(dirHandle, dirHandle.name);
    cleanupState.folderFiles = entries;
    await reconcileCleanupMatches();
  } catch (err) {
    if (err && err.name === "AbortError") return;
    console.error(err);
    showToast("Couldn't read that folder.");
  }
});

async function reconcileCleanupMatches() {
  cleanupState.matches = [];
  el.cleanupResults.innerHTML = "";

  // Build a lookup of imported records by sha256 for fast matching
  const recordsByHash = new Map();
  for (const r of cleanupState.importedRecords) {
    if (!recordsByHash.has(r.sha256)) recordsByHash.set(r.sha256, []);
    recordsByHash.get(r.sha256).push(r);
  }

  for (let i = 0; i < cleanupState.folderFiles.length; i++) {
    const entry = cleanupState.folderFiles[i];
    let liveHash;
    try {
      liveHash = await sha256File(entry.file);
    } catch (err) {
      continue; // unreadable file, skip
    }
    const possibleRecords = recordsByHash.get(liveHash);
    if (possibleRecords && possibleRecords.length > 0) {
      // Strict verification per the safety rule: hash AND filename must both match.
      const exactRecord = possibleRecords.find((r) => r.filename === entry.file.name);
      cleanupState.matches.push({
        folderFileIndex: i,
        record: exactRecord || possibleRecords[0],
        liveHash,
        verified: Boolean(exactRecord),
      });
    }
  }

  renderCleanupMatches();
}

function renderCleanupMatches() {
  el.cleanupResults.innerHTML = "";
  el.cleanupSelectAll.checked = false;

  if (cleanupState.matches.length === 0) {
    el.cleanupEmpty.hidden = false;
    el.cleanupToolbar.hidden = true;
    return;
  }
  el.cleanupEmpty.hidden = true;
  el.cleanupToolbar.hidden = false;

  cleanupState.matches.forEach((match, matchIndex) => {
    const entry = cleanupState.folderFiles[match.folderFileIndex];
    const row = document.createElement("div");
    row.className = "cleanup-match-row";
    row.dataset.matchIndex = String(matchIndex);

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "cleanup-select";
    cb.dataset.matchIndex = String(matchIndex);
    cb.addEventListener("change", updateCleanupBulkDeleteState);

    const info = document.createElement("div");
    info.className = "cleanup-match-info";

    const pathEl = document.createElement("div");
    pathEl.className = "cleanup-match-path";
    pathEl.textContent = entry.path;

    const subEl = document.createElement("div");
    subEl.className = "cleanup-match-sub";
    subEl.textContent = `${formatBytes(entry.file.size)} · matches record for "${match.record.filename}"`;

    info.appendChild(pathEl);
    info.appendChild(subEl);

    const badge = document.createElement("span");
    badge.className = "cleanup-match-badge " + (match.verified ? "verified" : "mismatch");
    badge.textContent = match.verified ? "Hash + name verified" : "Hash matches, name differs";

    const delBtn = document.createElement("button");
    delBtn.className = "btn-small danger";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => handleSingleCleanupDelete(match, entry, row));

    row.appendChild(cb);
    row.appendChild(info);
    row.appendChild(badge);
    row.appendChild(delBtn);

    el.cleanupResults.appendChild(row);
  });

  updateCleanupBulkDeleteState();
}

function updateCleanupBulkDeleteState() {
  const anyChecked = document.querySelectorAll(".cleanup-select:checked").length > 0;
  el.cleanupBulkDeleteBtn.disabled = !anyChecked;
}

el.cleanupSelectAll.addEventListener("change", () => {
  const checkboxes = document.querySelectorAll(".cleanup-select");
  checkboxes.forEach((cb) => { cb.checked = el.cleanupSelectAll.checked; });
  updateCleanupBulkDeleteState();
});

/* Core deletion routine — no confirmation prompt of its own.
   Callers (single/bulk/erase-all) handle confirmation upfront,
   so multi-file actions show one combined prompt instead of N. */
async function deleteCleanupMatch(match, entry) {
  if (!entry.canDelete || !entry.handle) {
    return { ok: false, reason: "no-handle" };
  }
  try {
    // Re-verify the live hash immediately before deleting, in case the
    // file changed on disk between the check and this action.
    const freshHash = await sha256File(entry.file);
    if (freshHash !== match.liveHash) {
      return { ok: false, reason: "changed" };
    }
    if (entry.dirHandle && entry.dirHandle.removeEntry) {
      await entry.dirHandle.removeEntry(entry.handle.name);
    } else if (entry.handle.remove) {
      await entry.handle.remove();
    } else {
      return { ok: false, reason: "no-handle" };
    }
    return { ok: true };
  } catch (err) {
    console.error(err);
    return { ok: false, reason: "error" };
  }
}

async function handleSingleCleanupDelete(match, entry, rowEl) {
  if (!match.verified) {
    const proceedAnyway = await askConfirmation(
      `This file's content hash matches your imported record, but the filename is different ` +
      `("${entry.file.name}" vs the recorded "${match.record.filename}"). Delete it anyway?`
    );
    if (!proceedAnyway) return;
  } else {
    const confirmed = await askConfirmation(
      `Delete "${entry.path}"? Its content hash and filename both match the imported record. This can't be undone.`
    );
    if (!confirmed) return;
  }

  const result = await deleteCleanupMatch(match, entry);
  if (result.ok) {
    rowEl.remove();
    showToast(`Deleted ${entry.path.split("/").pop()}`);
  } else if (result.reason === "no-handle") {
    openInfoModal(DELETE_UNAVAILABLE_MSG);
  } else if (result.reason === "changed") {
    showToast("Skipped — this file changed since it was checked. Re-scan the folder to be safe.");
  } else {
    showToast("Delete failed — the file may be in use or permission was revoked.");
  }
}

el.cleanupBulkDeleteBtn.addEventListener("click", async () => {
  const checked = Array.from(document.querySelectorAll(".cleanup-select:checked"));
  if (checked.length === 0) return;

  const selectedIndices = checked.map((cb) => Number(cb.dataset.matchIndex));
  const verifiedCount = selectedIndices.filter((i) => cleanupState.matches[i].verified).length;
  const mismatchCount = selectedIndices.length - verifiedCount;

  let message = `Delete ${selectedIndices.length} selected file${selectedIndices.length > 1 ? "s" : ""}? This can't be undone.`;
  if (mismatchCount > 0) {
    message += ` ${mismatchCount} of these matched by content hash only — the filename differs from the imported record.`;
  }
  const confirmed = await askConfirmation(message);
  if (!confirmed) return;

  await runCleanupBatchDelete(selectedIndices);
});

el.cleanupEraseAllBtn.addEventListener("click", async () => {
  if (cleanupState.matches.length === 0) return;

  const verifiedCount = cleanupState.matches.filter((m) => m.verified).length;
  const mismatchCount = cleanupState.matches.length - verifiedCount;

  let message = `Erase all ${cleanupState.matches.length} matched file${cleanupState.matches.length > 1 ? "s" : ""} shown below? This can't be undone.`;
  message += ` ${verifiedCount} are verified by hash and filename.`;
  if (mismatchCount > 0) {
    message += ` ${mismatchCount} matched by content hash only, with a different filename than the imported record.`;
  }
  const confirmed = await askConfirmation(message);
  if (!confirmed) return;

  const allIndices = cleanupState.matches.map((_, i) => i);
  await runCleanupBatchDelete(allIndices);
});

async function runCleanupBatchDelete(matchIndices) {
  let deletedCount = 0;
  let skippedChanged = 0;
  let blockedCount = 0;
  let errorCount = 0;

  // Delete from the highest index downward so removing rows doesn't
  // shift the meaning of remaining indices mid-loop.
  const sortedIndices = [...matchIndices].sort((a, b) => b - a);

  for (const matchIndex of sortedIndices) {
    const match = cleanupState.matches[matchIndex];
    const entry = cleanupState.folderFiles[match.folderFileIndex];
    const rowEl = el.cleanupResults.querySelector(`.cleanup-match-row[data-match-index="${matchIndex}"]`);

    const result = await deleteCleanupMatch(match, entry);
    if (result.ok) {
      deletedCount++;
      if (rowEl) rowEl.remove();
    } else if (result.reason === "no-handle") {
      blockedCount++;
    } else if (result.reason === "changed") {
      skippedChanged++;
    } else {
      errorCount++;
    }
  }

  if (deletedCount > 0) {
    showToast(`Deleted ${deletedCount} file${deletedCount > 1 ? "s" : ""}.`);
  }
  if (blockedCount > 0) {
    openInfoModal(`${blockedCount} file${blockedCount > 1 ? "s" : ""} couldn't be deleted because they lack a removable handle. ` + DELETE_UNAVAILABLE_MSG);
  } else if (skippedChanged > 0 || errorCount > 0) {
    const parts = [];
    if (skippedChanged > 0) parts.push(`${skippedChanged} changed since checking and were skipped`);
    if (errorCount > 0) parts.push(`${errorCount} failed to delete (in use or permission revoked)`);
    showToast(parts.join("; ") + ".");
  }

  updateCleanupBulkDeleteState();
  if (el.cleanupResults.children.length === 0) {
    el.cleanupEmpty.hidden = false;
    el.cleanupToolbar.hidden = true;
  }
}

/* ---------- Init ---------- */

initBrowserPill();
refreshHistoryBar();
