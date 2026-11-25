// 把一张表（二维字符串数组）排成「等宽」文本行。
// 对齐能成立的前提是字体本身等宽：东亚全角字 = 2 个西文半角位（宋体/新宋体
// 正好是这样），所以这里按「显示格数」而不是 JS 字符数来算列宽。
// 表格路径用 fontFamily='宋体'（见 document.mjs），不用 Consolas：Consolas 没有
// 汉字字形，回退字形宽度不受控，中文列必然错位。

export const TABLE_ROWS_PER_PAGE = 40;
export const CELL_SEPARATOR = ' | ';
export const NULL_CELL = '';
export const ELLIPSIS = '\u2026';

const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

function codepointCells(code) {
  for (const range of WIDE_RANGES) {
    if (code >= range[0] && code <= range[1]) return 2;
  }
  return 1;
}

export function charCells(char) {
  return codepointCells(char.codePointAt(0));
}

export function displayWidth(text) {
  let width = 0;
  for (const char of String(text === null || text === undefined ? '' : text)) {
    width += charCells(char);
  }
  return width;
}

export function truncateDisplay(text, maxCells) {
  const source = String(text === null || text === undefined ? '' : text);
  if (displayWidth(source) <= maxCells) return source;
  const ellipsisCells = displayWidth(ELLIPSIS);
  if (maxCells <= ellipsisCells) return ELLIPSIS.slice(0, Math.max(0, maxCells));
  const budget = maxCells - ellipsisCells;
  let out = '';
  let used = 0;
  for (const char of source) {
    const cells = charCells(char);
    if (used + cells > budget) break;
    out += char;
    used += cells;
  }
  return out + ELLIPSIS;
}

export function padDisplay(text, cells) {
  const width = displayWidth(text);
  return width >= cells ? String(text) : String(text) + ' '.repeat(cells - width);
}

function toCell(value) {
  if (value === null || value === undefined) return NULL_CELL;
  return String(value);
}

function columnWidths(rows, columnCount, maxCells, minWidth) {
  const widths = new Array(columnCount).fill(1);
  for (const row of rows) {
    for (let i = 0; i < columnCount; i += 1) {
      widths[i] = Math.max(widths[i], displayWidth(toCell(row[i])));
    }
  }
  const cap = Math.max(minWidth, Math.min(30, maxCells));
  for (let i = 0; i < columnCount; i += 1) widths[i] = Math.min(widths[i], cap);

  const totalOf = () => widths.reduce((a, b) => a + b, 0) + CELL_SEPARATOR.length * (columnCount - 1);
  let guard = 0;
  while (totalOf() > maxCells && guard < 4000) {
    let widest = -1;
    let index = -1;
    for (let i = 0; i < columnCount; i += 1) {
      if (widths[i] > minWidth && widths[i] > widest) {
        widest = widths[i];
        index = i;
      }
    }
    if (index < 0) break;
    widths[index] -= 1;
    guard += 1;
  }
  return widths;
}

function renderRow(cells, widths) {
  const parts = [];
  for (let i = 0; i < widths.length; i += 1) {
    parts.push(padDisplay(truncateDisplay(toCell(cells[i]), widths[i]), widths[i]));
  }
  return parts.join(CELL_SEPARATOR);
}

function renderSeparator(widths) {
  return widths.map(function (width) { return '-'.repeat(width); }).join('-+-');
}

function leadingSize(level) {
  return level === 1 ? 16 : level === 2 ? 14 : level === 3 ? 12.5 : null;
}

// rows[0] 视为表头；每 rowsPerPage 行强制分页并重复表头。
export function buildTableLines(options) {
  const rows = Array.isArray(options.rows) ? options.rows.slice() : [];
  const maxCells = Math.max(12, Number(options.maxCells) || 80);
  const rowsPerPage = Math.max(5, Number(options.rowsPerPage) || TABLE_ROWS_PER_PAGE);
  const sheetName = String(options.sheetName || '');
  const sheets = Array.isArray(options.sheets) ? options.sheets : [];
  const minWidth = Math.max(3, Math.min(6, Math.floor(maxCells / Math.max(1, 4))));

  let columnCount = 0;
  for (const row of rows) columnCount = Math.max(columnCount, Array.isArray(row) ? row.length : 0);
  if (columnCount === 0) {
    return { lines: [], columns: 0, maxCells, pages: 0, totalWidth: 0 };
  }
  const widths = columnWidths(rows, columnCount, maxCells, minWidth);
  const headerCells = Array.isArray(rows[0]) ? rows[0] : [];
  const dataRows = rows.slice(1);
  const headerLine = renderRow(headerCells, widths);
  const separatorLine = renderSeparator(widths);

  const lines = [];
  // 标题不加粗：宋体没有真实粗体，GDI+ 合成粗体的字形在 PDF 里不可提取
  // （打印外观正常，但文字层搜不到）。改用字号区分层次，保证可复制/可搜索。
  lines.push({ text: '工作表：' + sheetName, size: leadingSize(3), bold: false });
  if (sheets.length > 1) {
    lines.push({
      text: '（工作簿共 ' + sheets.length + ' 张表，仅打印第一张：' + sheetName + '）',
      size: null,
      bold: false,
    });
  }
  lines.push({ text: headerLine, size: null, bold: true });
  lines.push({ text: separatorLine, size: null, bold: false });

  const pages = Math.max(1, Math.ceil(dataRows.length / rowsPerPage));
  for (let index = 0; index < dataRows.length; index += 1) {
    if (index > 0 && index % rowsPerPage === 0) {
      lines.push({ text: headerLine, size: null, bold: true, pageBreak: true });
      lines.push({ text: separatorLine, size: null, bold: false });
    }
    lines.push({ text: renderRow(dataRows[index], widths), size: null, bold: false });
  }

  return {
    lines,
    columns: columnCount,
    widths,
    maxCells,
    rows: dataRows.length,
    pages,
    totalWidth: widths.reduce((a, b) => a + b, 0) + CELL_SEPARATOR.length * (widths.length - 1),
    sample: lines.slice(0, 5).map(function (line) { return line.text; }),
  };
}
