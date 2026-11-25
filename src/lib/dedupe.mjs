import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEDUPE_FILE = '.dedupe.json';
const KEEP_MS = 3600 * 1000;
const MAX_ENTRIES = 200;

export function hashChunks(chunks) {
  const hash = crypto.createHash('sha256');
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest('hex');
}

// 文件型输入（PDF/DOCX/XLSX）按源文件字节算内容哈希：几百 MB 的渲染位图不该整块读进内存。
export function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    let read = 0;
    do {
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read > 0) hash.update(buffer.subarray(0, read));
    } while (read > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

// Content hash + everything that changes the physical output.
export function buildKey({ contentHash, printer, copies, paper, landscape }) {
  return crypto
    .createHash('sha256')
    .update([contentHash, printer, String(copies), paper, landscape ? '1' : '0'].join('\n'))
    .digest('hex');
}

export function storePath(logDir) {
  return path.join(logDir, DEDUPE_FILE);
}

function emptyStore() {
  return { version: 1, entries: {} };
}

export function readStore(logDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(logDir), 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.entries && typeof raw.entries === 'object') {
      return raw;
    }
  } catch {
    // missing or corrupt file: start from an empty store, never fail a print
  }
  return emptyStore();
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

export function findRecent(logDir, key, windowMs, now = Date.now()) {
  const entry = readStore(logDir).entries[key];
  if (!entry || typeof entry.at !== 'number') return null;
  if (now - entry.at > windowMs) return null;
  return entry;
}

export function recordPrint(logDir, key, info, now = Date.now()) {
  const store = readStore(logDir);
  const entries = {};
  for (const [k, v] of Object.entries(store.entries)) {
    if (v && typeof v.at === 'number' && now - v.at <= KEEP_MS) entries[k] = v;
  }
  entries[key] = { at: now, ...info };
  const kept = Object.keys(entries)
    .sort((a, b) => entries[b].at - entries[a].at)
    .slice(0, MAX_ENTRIES);
  const trimmed = {};
  for (const k of kept) trimmed[k] = entries[k];
  writeAtomic(storePath(logDir), JSON.stringify({ version: 1, entries: trimmed }));
}
