import fs from 'node:fs';
import { CliError, EXIT } from './errors.mjs';
import { DOCX_SCRIPT, XLSX_SCRIPT, runPythonScript } from './py.mjs';

// 路径 B（保内容）：Office COM 不可用时，用 Python 读出文字/单元格再排版。
// python-docx / openpyxl 缺失时脚本自己退回 zip+ElementTree，所以「零依赖」仍然成立。

const HEADING_PT = new Map([
  [1, 16],
  [2, 14],
  [3, 12.5],
]);

function ensureReadable(file) {
  if (!fs.existsSync(DOCX_SCRIPT) || !fs.existsSync(XLSX_SCRIPT)) {
    throw new CliError(EXIT.RENDER, '缺少 OOXML 解析脚本（src/ps/docx-text.py、src/ps/xlsx-text.py）');
  }
}

export function docxToLines(file) {
  ensureReadable(file);
  const result = runPythonScript(DOCX_SCRIPT, [file], { label: 'DOCX 文字解析', timeoutMs: 120000 });
  const paragraphs = Array.isArray(result.parsed.paragraphs) ? result.parsed.paragraphs : [];
  if (paragraphs.length === 0) {
    throw new CliError(EXIT.RENDER, 'DOCX 里没有可提取的文字：' + file);
  }
  const lines = paragraphs.map(function (paragraph) {
    const level = Number(paragraph.level || 0);
    const size = HEADING_PT.get(level) || null;
    return { text: String(paragraph.text || ''), size, bold: Boolean(size) };
  });
  return {
    source: String(result.parsed.source || 'ooxml'),
    lines,
    paragraphs: lines.length,
    headings: lines.filter(function (line) { return line.size; }).length,
    chars: lines.reduce(function (sum, line) { return sum + line.text.length; }, 0),
  };
}

export function xlsxToRows(file) {
  ensureReadable(file);
  const result = runPythonScript(XLSX_SCRIPT, [file], { label: 'XLSX 表格解析', timeoutMs: 120000 });
  const rows = Array.isArray(result.parsed.rows) ? result.parsed.rows : [];
  if (rows.length === 0) {
    throw new CliError(EXIT.RENDER, 'XLSX 第一张工作表是空的：' + file);
  }
  const sheets = Array.isArray(result.parsed.sheets) ? result.parsed.sheets.map(String) : [];
  return {
    source: String(result.parsed.source || 'ooxml'),
    sheet: String(result.parsed.sheet || ''),
    sheets,
    rows,
    colWidths: Array.isArray(result.parsed.colWidths) ? result.parsed.colWidths : [],
    truncated: Boolean(result.parsed.truncated),
  };
}
