import fs from 'node:fs';
import path from 'node:path';

function pad(n) {
  return String(n).padStart(2, '0');
}

export function logFileForDate(date = new Date()) {
  const name = `print-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}.jsonl`;
  return name;
}

export function appendPrintLog(logDir, record) {
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, logFileForDate(new Date()));
  const line = JSON.stringify(record) + '\n';
  fs.appendFileSync(file, line, { encoding: 'utf8' });
  return file;
}
