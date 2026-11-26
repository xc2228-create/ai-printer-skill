import fs from 'node:fs';
import path from 'node:path';
import { CliError, EXIT } from './errors.mjs';

export const DEFAULT_FONT_PT = 10.5;
export const DEFAULT_LINE_SPACING = 1.5;
export const DEFAULT_MARGIN_MM = 20;
export const MIN_FONT_PT = 6;
export const MAX_FONT_PT = 72;
export const MAX_MARGIN_MM = 50;

// <size>[b] prefix marks a styled line (markdown heading) on the
// stdin channel to print-text.ps1. Both control characters are stripped from
// the payload by sanitizeLines(), so a line of real text can never fake it.
export const STYLE_START = '\u0001';
export const STYLE_END = '\u0002';

const HEADING_PT = new Map([
  [1, 16],
  [2, 14],
  [3, 12.5],
  [4, 11.5],
  [5, 11],
  [6, 11],
]);

export function decodeTextBuffer(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buffer);
    } catch {
      return buffer.toString('utf8');
    }
  }
}

// Inline markdown only (bold / links / code / html / entities). Block syntax is
// handled line by line in markdownToLines() so headings keep their level.
function stripInline(input) {
  let text = String(input);
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, function (_m, alt) {
    return alt ? '[图片: ' + alt + ']' : '[图片]';
  });
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(\*|_)(.*?)\1/g, '$2');
  text = text.replace(/~~(.*?)~~/g, '$1');
  text = text.replace(/\x60([^\x60]+)\x60/g, '$1');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/\\([\\\x60*{}\[\]()#+\-.!_>])/g, '$1');
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return text;
}

function isHr(line) {
  return /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line);
}

function isTableSeparator(line) {
  return line.indexOf('-') >= 0 && /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/.test(line);
}

// Markdown -> styled lines. Level 1/2/3 headings become 16 / 14 / 12.5 pt bold,
// list items get the '· ' bullet, everything else is inline-stripped.
export function markdownToLines(input) {
  let text = String(input).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  text = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/^[ \t]*(\x60{3}|~~~)[^\n]*$/gm, '');
  const lines = [];
  for (const rawLine of text.split('\n')) {
    if (isHr(rawLine)) {
      lines.push({ text: '', size: null, bold: false });
      continue;
    }
    if (isTableSeparator(rawLine)) continue;
    const heading = /^[ \t]{0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(rawLine);
    if (heading) {
      const level = heading[1].length;
      lines.push({
        text: stripInline(heading[2]).trim(),
        size: HEADING_PT.get(level) || 11,
        bold: level <= 3,
      });
      continue;
    }
    if (/^[ \t]*\[[^\]]+\]:[ \t]*\S+/.test(rawLine)) continue;
    let body = rawLine.replace(/^[ \t]*>[ \t]?/, '');
    const listItem = /^[ \t]*[-*+][ \t]+(.*)$/.exec(body);
    if (listItem) {
      lines.push({ text: '· ' + stripInline(listItem[1]), size: null, bold: false });
      continue;
    }
    const tableRow = /^[ \t]*\|(.+)\|[ \t]*$/.exec(body);
    if (tableRow) {
      body = tableRow[1].split('|').map(function (cell) { return cell.trim(); }).join('  ');
    }
    lines.push({ text: stripInline(body), size: null, bold: false });
  }
  return lines;
}

function sanitizeLines(lines) {
  const out = [];
  for (const raw of lines) {
    let text = String(raw && raw.text !== undefined && raw.text !== null ? raw.text : '');
    text = text
      .replace(/\t/g, '    ')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/[ \u00A0]+$/g, '');
    const size = raw && typeof raw.size === 'number' && raw.size >= 4 && raw.size <= 72 ? raw.size : null;
    const bold = Boolean(raw && raw.bold);
    // pageBreak: 强制换页（XLSX 表格每 40 行重开一页并重复表头用）
    const pageBreak = Boolean(raw && raw.pageBreak);
    if (text === '' && out.length > 0 && out[out.length - 1].text === '') continue;
    out.push({ text, size, bold: size ? bold : false, pageBreak });
  }
  while (out.length > 0 && out[0].text === '') out.shift();
  while (out.length > 0 && out[out.length - 1].text === '') out.pop();
  if (out.length === 0) {
    throw new CliError(EXIT.ARGUMENT, 'text content is empty after preprocessing');
  }
  return out;
}

export function plainToLines(input) {
  const text = String(input).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  return text.split('\n').map(function (line) {
    return { text: line, size: null, bold: false };
  });
}

export function prepareTextLines(input, options = {}) {
  return sanitizeLines(options.markdown ? markdownToLines(input) : plainToLines(input));
}

export function readTextFile(file) {
  try {
    return decodeTextBuffer(fs.readFileSync(file));
  } catch (error) {
    throw new CliError(EXIT.ARGUMENT, 'cannot read text file: ' + error.message);
  }
}

export function prepareFileLines(file) {
  const ext = path.extname(file).toLowerCase();
  return prepareTextLines(readTextFile(file), { markdown: ext === '.md' });
}

// 控制串协议（print-text.ps1 解析，可连续出现多个前缀）：
//   \u0001<size>[b]\u0002  该行用 size 磅、可选加粗
//   \u0001PB\u0002         该行前强制换页
export const PAGE_BREAK_TOKEN = 'PB';

export function encodeStyledLines(lines) {
  return lines
    .map(function (line) {
      const parts = [];
      if (line.pageBreak) parts.push(STYLE_START + PAGE_BREAK_TOKEN + STYLE_END);
      if (line.size) parts.push(STYLE_START + String(line.size) + (line.bold ? 'b' : '') + STYLE_END);
      return parts.join('') + line.text;
    })
    .join('\n');
}

// 让非文本来源（DOCX 段落 / XLSX 表格）也能复用同一套清洗规则。
export function sanitizeStyledLines(lines) {
  return sanitizeLines(lines);
}

// Kept for callers that still want the plain text form.
export function prepareText(file) {
  return prepareFileLines(file).map(function (line) { return line.text; }).join('\n');
}

export function stripMarkdown(input) {
  return markdownToLines(input).map(function (line) { return line.text; }).join('\n');
}

export function normalizeText(input) {
  let text = String(input).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  text = text.replace(/\t/g, '    ');
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  text = text
    .split('\n')
    .map(function (line) { return line.replace(/[ \u00A0]+$/g, ''); })
    .join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/^\n+/, '').replace(/\n+$/, '');
  return text;
}

export function clampFontSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < MIN_FONT_PT || n > MAX_FONT_PT) {
    throw new CliError(EXIT.ARGUMENT, '--font-size must be between ' + MIN_FONT_PT + ' and ' + MAX_FONT_PT + ' pt');
  }
  return n;
}

export function clampMarginMm(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_MARGIN_MM) {
    throw new CliError(EXIT.ARGUMENT, '--margin must be between 0 and ' + MAX_MARGIN_MM + ' mm');
  }
  return n;
}
