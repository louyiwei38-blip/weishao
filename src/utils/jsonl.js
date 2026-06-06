import { appendFileSync, existsSync, renameSync, rmSync, statSync } from 'fs';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_ARCHIVES = 5;

/**
 * Append one JSON line; rotate the file when it exceeds maxBytes.
 * Rotation: file.jsonl → file.jsonl.1 → … → file.jsonl.5 (oldest dropped).
 */
export function appendJsonl(filePath, entry, maxBytes = DEFAULT_MAX_BYTES) {
  rotateIfNeeded(filePath, maxBytes);
  appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
}

function rotateIfNeeded(filePath, maxBytes) {
  if (!existsSync(filePath)) return;

  const { size } = statSync(filePath);
  if (size < maxBytes) return;

  const oldest = `${filePath}.${MAX_ARCHIVES}`;
  if (existsSync(oldest)) {
    try { rmSync(oldest); } catch { /* best-effort */ }
  }

  for (let i = MAX_ARCHIVES - 1; i >= 1; i--) {
    const src = `${filePath}.${i}`;
    const dst = `${filePath}.${i + 1}`;
    if (existsSync(src)) renameSync(src, dst);
  }

  renameSync(filePath, `${filePath}.1`);
}
