import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError, EXIT, messageOf } from './errors.mjs';
import { hashFile } from './dedupe.mjs';
import { assertPageLimit, readPdfInfo, renderPdfPages } from './pdfdoc.mjs';
import { comAvailable, convertWithOffice } from './office.mjs';
import { docxToLines, xlsxToRows } from './ooxml.mjs';
import { TABLE_ROWS_PER_PAGE, buildTableLines } from './tabletext.mjs';
import { encodeStyledLines, sanitizeStyledLines } from './text.mjs';

// PDF / DOCX / XLSX 的统一入口：把任意一种文档变成「要么每页一张 PNG（imageList），
// 要么一段结构化文本（text）」，后面的打印链路完全复用图片/文本两条老路。
//
//   PDF  -> pymupdf 逐页 200dpi PNG                     (A)
//   DOCX -> A: Word COM 转 PDF -> 同上；B: python-docx/zip -> 结构化文本
//   XLSX -> A: Excel COM 只导第一张表 -> 同上；B: openpyxl/zip -> 等宽表格文本
//
// 临时文件一律落在系统 TEMP（printer-doc-*），渲染完立刻清理。

// 表格用宋体：ASCII 半角、汉字全角，两者正好 1:2，列才对得齐。
export const TABLE_FONT_FAMILY = '\u5b8b\u4f53';
// Office COM 转换上限 90 秒；PRINTER_COM_TIMEOUT_MS 只给自测用（模拟超时→降级）。
export const COM_TIMEOUT_MS = Number(process.env.PRINTER_COM_TIMEOUT_MS || 90000);

const PAPER_PT = new Map([
  ['A4', [595.44, 841.68]],
  ['A5', [419.76, 595.44]],
  ['Letter', [612, 792]],
]);

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'printer-doc-'));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function cleanupTempDir(dir) {
  if (!dir) return;
  for (let i = 0; i < 5; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      sleepSync(150);
    }
  }
}

// 文本链路一页能放多少「半角位」：宋体 10.5pt 的半角字宽 = 字号/2。
// 乘 0.99 是 print-text.ps1 自己的折行阈值，再减 3 位抵消 GDI+ 的测量余量。
export function textBudgetCells(options) {
  const size = PAPER_PT.get(options.paper) || PAPER_PT.get('A4');
  const pageWidth = options.landscape ? size[1] : size[0];
  const marginPt = (Number(options.marginMm) || 0) / 25.4 * 72;
  const contentWidth = pageWidth - 2 * marginPt;
  const halfCell = Math.max(1, Number(options.fontPt) || 10.5) / 2;
  return Math.max(12, Math.floor((contentWidth * 0.99) / halfCell) - 3);
}

function isHardStop(error) {
  return error instanceof CliError && (error.exitCode === EXIT.ARGUMENT || error.exitCode === EXIT.DUPLICATE);
}

function preparePdf(input, ctx) {
  const info = readPdfInfo(input.absolute);
  assertPageLimit(info.pages, ctx.force, '该 PDF ');
  const landscape = Boolean(ctx.landscapeFlag) || info.landscape;
  const contentHash = hashFile(input.absolute);
  const doc = {
    format: 'pdf',
    path: 'A',
    source: 'pymupdf',
    pages: info.pages,
    pageSize: info.width + 'x' + info.height + 'pt',
    landscape: info.landscape,
    landscapePages: info.landscapePages,
    sheet: null,
    sheets: null,
    note: null,
  };
  if (ctx.dryRun) {
    return { kind: 'imageList', imageListFile: null, tempDir: null, stdin: null, contentHash, effectiveLandscape: landscape, textChars: null, fontFamily: null, doc };
  }
  ctx.checkDuplicate(contentHash, landscape);
  const tempDir = makeTempDir();
  try {
    const rendered = renderPdfPages(input.absolute, tempDir);
    const listFile = path.join(tempDir, 'pages.txt');
    fs.writeFileSync(listFile, rendered.pngs.join('\n'), 'utf8');
    return {
      kind: 'imageList',
      imageListFile: listFile,
      tempDir,
      stdin: null,
      contentHash,
      effectiveLandscape: landscape,
      textChars: null,
      fontFamily: null,
      doc: { ...doc, pages: rendered.pages, dpi: rendered.dpi },
    };
  } catch (error) {
    cleanupTempDir(tempDir);
    throw error;
  }
}

function prepareDocx(input, ctx) {
  const contentHash = hashFile(input.absolute);
  const reasons = [];
  const comOk = comAvailable('word');

  if (ctx.dryRun) {
    return {
      kind: comOk ? 'imageList' : 'text',
      imageListFile: null,
      tempDir: null,
      stdin: null,
      contentHash,
      effectiveLandscape: Boolean(ctx.landscapeFlag),
      textChars: null,
      fontFamily: null,
      doc: {
        format: 'docx',
        path: comOk ? 'A' : 'B',
        source: comOk ? 'Word COM' : 'python-docx',
        pages: null,
        sheet: null,
        sheets: null,
        note: comOk ? 'A: Word COM -> PDF -> 渲染' : 'B: 解析 word/document.xml',
      },
    };
  }

  if (comOk) {
    const tempDir = makeTempDir();
    try {
      const pdfPath = path.join(tempDir, 'word.pdf');
      convertWithOffice({ kind: 'word', file: input.absolute, outputPdf: pdfPath, timeoutMs: ctx.comTimeoutMs || COM_TIMEOUT_MS });
      const info = readPdfInfo(pdfPath);
      assertPageLimit(info.pages, ctx.force, '该 DOCX 转出的 PDF ');
      const landscape = Boolean(ctx.landscapeFlag) || info.landscape;
      ctx.checkDuplicate(contentHash, landscape);
      const rendered = renderPdfPages(pdfPath, tempDir);
      const listFile = path.join(tempDir, 'pages.txt');
      fs.writeFileSync(listFile, rendered.pngs.join('\n'), 'utf8');
      return {
        kind: 'imageList',
        imageListFile: listFile,
        tempDir,
        stdin: null,
        contentHash,
        effectiveLandscape: landscape,
        textChars: null,
        fontFamily: null,
        doc: {
          format: 'docx',
          path: 'A',
          source: 'Word COM',
          pages: rendered.pages,
          landscape,
          sheet: null,
          sheets: null,
          note: null,
        },
      };
    } catch (error) {
      cleanupTempDir(tempDir);
      if (isHardStop(error)) throw error;
      reasons.push('Word COM 失败：' + messageOf(error));
    }
  } else {
    reasons.push('Word COM 不可用（Word.Application 未注册，或设置了 PRINTER_NO_COM=1）');
  }

  let extracted;
  try {
    extracted = docxToLines(input.absolute);
  } catch (error) {
    throw new CliError(
      EXIT.RENDER,
      'Word COM 不可用且 XML 解析失败：' + reasons.concat(['XML 解析：' + messageOf(error)]).join('；'),
    );
  }
  const lines = sanitizeStyledLines(extracted.lines);
  const landscape = Boolean(ctx.landscapeFlag);
  ctx.checkDuplicate(contentHash, landscape);
  return {
    kind: 'text',
    imageListFile: null,
    tempDir: null,
    stdin: encodeStyledLines(lines),
    contentHash,
    effectiveLandscape: landscape,
    textChars: extracted.chars,
    fontFamily: null,
    doc: {
      format: 'docx',
      path: 'B',
      source: extracted.source,
      pages: null,
      sheet: null,
      sheets: null,
      paragraphs: extracted.paragraphs,
      headings: extracted.headings,
      note: reasons.join('；'),
    },
  };
}

function prepareXlsx(input, ctx) {
  const contentHash = hashFile(input.absolute);
  const table = xlsxToRows(input.absolute);
  const dataRows = Math.max(0, table.rows.length - 1);
  const estimatedPages = Math.max(1, Math.ceil(dataRows / TABLE_ROWS_PER_PAGE));
  const multiSheet = table.sheets.length > 1;
  const baseDoc = {
    format: 'xlsx',
    sheet: table.sheet,
    sheets: table.sheets,
    rows: dataRows,
    source: table.source,
    truncated: table.truncated,
  };
  const multiNote = multiSheet ? '多表：仅打印第一张：' + table.sheet : null;
  const comOk = comAvailable('excel');

  if (ctx.dryRun) {
    return {
      kind: comOk ? 'imageList' : 'text',
      imageListFile: null,
      tempDir: null,
      stdin: null,
      contentHash,
      effectiveLandscape: Boolean(ctx.landscapeFlag),
      textChars: null,
      fontFamily: comOk ? null : TABLE_FONT_FAMILY,
      doc: {
        ...baseDoc,
        path: comOk ? 'A' : 'B',
        pages: null,
        estimatedPages,
        note: comOk ? (multiNote || 'A: Excel COM -> 仅第一张表') : (multiNote || 'B: 等宽表格文本'),
      },
    };
  }

  const reasons = [];
  if (comOk) {
    const tempDir = makeTempDir();
    try {
      const pdfPath = path.join(tempDir, 'excel.pdf');
      convertWithOffice({
        kind: 'excel',
        file: input.absolute,
        outputPdf: pdfPath,
        firstSheetOnly: true,
        timeoutMs: ctx.comTimeoutMs || COM_TIMEOUT_MS,
      });
      const info = readPdfInfo(pdfPath);
      assertPageLimit(info.pages, ctx.force, '该 XLSX 转出的 PDF ');
      const landscape = Boolean(ctx.landscapeFlag) || info.landscape;
      ctx.checkDuplicate(contentHash, landscape);
      const rendered = renderPdfPages(pdfPath, tempDir);
      const listFile = path.join(tempDir, 'pages.txt');
      fs.writeFileSync(listFile, rendered.pngs.join('\n'), 'utf8');
      return {
        kind: 'imageList',
        imageListFile: listFile,
        tempDir,
        stdin: null,
        contentHash,
        effectiveLandscape: landscape,
        textChars: null,
        fontFamily: null,
        doc: { ...baseDoc, path: 'A', pages: rendered.pages, landscape, note: multiNote },
      };
    } catch (error) {
      cleanupTempDir(tempDir);
      if (isHardStop(error)) throw error;
      reasons.push('Excel COM 失败：' + messageOf(error));
    }
  } else {
    reasons.push('Excel COM 不可用（Excel.Application 未注册，或设置了 PRINTER_NO_COM=1）');
  }

  assertPageLimit(estimatedPages, ctx.force, '该 XLSX 表格（按每页 ' + TABLE_ROWS_PER_PAGE + ' 行估算）');
  const budget = {
    paper: ctx.paper,
    marginMm: ctx.marginMm,
    fontPt: ctx.fontPt,
    landscape: Boolean(ctx.landscapeFlag),
  };
  const built = buildTableLines({
    rows: table.rows,
    sheetName: table.sheet,
    sheets: table.sheets,
    maxCells: textBudgetCells(budget),
    rowsPerPage: TABLE_ROWS_PER_PAGE,
  });
  let lines;
  try {
    lines = sanitizeStyledLines(built.lines);
  } catch (error) {
    throw new CliError(EXIT.RENDER, 'XLSX 表格排版结果为空：' + messageOf(error));
  }
  const landscape = Boolean(ctx.landscapeFlag);
  ctx.checkDuplicate(contentHash, landscape);
  return {
    kind: 'text',
    imageListFile: null,
    tempDir: null,
    stdin: encodeStyledLines(lines),
    contentHash,
    effectiveLandscape: landscape,
    textChars: lines.reduce(function (sum, line) { return sum + line.text.length; }, 0),
    fontFamily: TABLE_FONT_FAMILY,
    doc: {
      ...baseDoc,
      path: 'B',
      pages: built.pages,
      columns: built.columns,
      totalWidth: built.totalWidth,
      maxCells: built.maxCells,
      sample: built.sample,
      note: [multiNote, reasons.join('；')].filter(Boolean).join('；') || null,
    },
  };
}

export async function prepareDocument(input, ctx) {
  if (input.extension === '.pdf') return preparePdf(input, ctx);
  if (input.extension === '.docx') return prepareDocx(input, ctx);
  if (input.extension === '.xlsx') return prepareXlsx(input, ctx);
  throw new CliError(EXIT.ARGUMENT, 'unsupported document type: ' + (input.extension || '(none)'));
}
