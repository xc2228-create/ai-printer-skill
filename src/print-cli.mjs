#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { CliError, EXIT, messageOf } from './lib/errors.mjs';
import {
  CONFIG_PATH,
  DEFAULT_OUT_DIR,
  LOG_DIR,
  PROJECT_ROOT,
  loadConfig,
} from './lib/config.mjs';
import {
  annotatePrinters,
  listPrinters,
  fastSelectPrinter,
  selectPrinter,
  systemDefaultPrinter,
} from './lib/printers.mjs';
import {
  DEFAULT_FONT_PT,
  DEFAULT_LINE_SPACING,
  DEFAULT_MARGIN_MM,
  clampFontSize,
  clampMarginMm,
  encodeStyledLines,
  prepareFileLines,
  prepareTextLines,
} from './lib/text.mjs';
import { readImageInfo } from './lib/image.mjs';
import { runPrintJob } from './lib/printjob.mjs';
import { appendPrintLog } from './lib/log.mjs';
import { buildKey, findRecent, hashChunks, recordPrint } from './lib/dedupe.mjs';
import { isUrl, renderUrl } from './lib/urlrender.mjs';
import { COM_TIMEOUT_MS, prepareDocument } from './lib/document.mjs';
import { MAX_DOC_PAGES } from './lib/pdfdoc.mjs';

const CLI_VERSION = '1.4.0';
const SUPPORTED_EXTENSIONS = new Set(['.txt', '.md', '.png', '.jpg', '.jpeg', '.pdf', '.docx', '.xlsx']);
const BLOCKED_EXTENSIONS = new Set(['.exe', '.bat', '.cmd', '.ps1', '.msi', '.vbs', '.scr']);
const TEXT_EXTENSIONS = new Set(['.txt', '.md']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const DOC_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx']);
const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const MAX_DOC_BYTES = 200 * 1024 * 1024;
const DEFAULT_DEDUPE_SECONDS = 60;
const MAX_DEDUPE_SECONDS = 86400;
const PAPER_NAMES = new Map([
  ['a4', 'A4'],
  ['a5', 'A5'],
  ['letter', 'Letter'],
]);

const KNOWN_COMMANDS = new Set(['printers', 'print', 'status', 'help', 'text', 'url']);
const VALUE_OPTIONS = new Set(['--printer', '--copies', '--paper', '--out', '--dedupe', '--font-size', '--margin', '--xlsx-scale', '--fit-pages']);
const FLAG_OPTIONS = new Set(['--json', '--landscape', '--dry-run', '--force', '--file', '--quiet', '-q', '--help', '-h', '--fast', '--no-com']);

function helpText() {
  return [
    'print-cli ' + CLI_VERSION + ' — Windows AI printer CLI (zero dependencies)',
    '',
    'Command name: printer (installed shim). NOT print — print is a Windows built-in',
    '  (C:\\Windows\\System32\\print.exe) and always wins on PATH. Never use print.',
    '',
    'Usage:',
    '  printer <input> --printer <name> [options]         (print subcommand omitted)',
    '  printer print <input...> --printer <name>          (batch: several inputs)',
    '  printer text "<string>" --printer <name>           (format inline text)',
    '  printer url <http(s)://...> --printer <name>       (Edge -> PDF -> PNG -> print)',
    '  printer printers [--json]',
    '  printer status [--json]',
    '',
    'Inputs (one or more positionals; executed in order, errors do not stop the batch):',
    '  <file>             .txt .md .png .jpg .jpeg .pdf .docx .xlsx',
    '  text:<string>      inline text inside a batch',
    '  url:<url>          web page inside a batch',
    '  A single bare argument that is not an existing file and not a URL is treated as text.',
    '  --file             force every positional to be a file path',
    '',
    'Documents (.pdf .docx .xlsx):',
    '  .pdf               every page -> 200dpi PNG -> image printing (pymupdf)',
    '  .docx              A: Word COM -> PDF -> PNG; B: word/document.xml -> structured text',
    '  .xlsx              A: Excel COM -> first sheet PDF; B: first sheet -> fixed-width table',
    '  Documents above ' + MAX_DOC_PAGES + ' pages are refused unless --force is given.',
    '  --fast, --no-com    skip Office COM for .docx/.xlsx (much faster, layout is re-flowed)',
    '  --xlsx-scale <n>    Excel export zoom: 80/90/100 or "actual" (bigger text, may span pages)',
    '  --fit-pages <n>     auto-shrink font/spacing so the content fits in n pages (e.g. one A4 page)',
    '  PRINTER_NO_COM=1   same as --fast, useful for CI / machines without Office',
    '',
    'Print options:',
    '  --printer <name>    explicit printer (never falls back to the system default)',
    '  --copies <n>        copies, default 1; >5 requires --force; maximum 50',
    '  --paper A4|A5|Letter default A4',
    '  --landscape         landscape orientation',
    '  --dry-run           validate only; no print job and no PDF',
    '  --json              machine-readable JSON envelope (includes resultLine)',
    '  --quiet, -q         one line only: OK 1p 3.2s -> <printer>',
    '  --out <dir>         PDF output directory (default: <project>/test-out)',
    '  --force             allow copies above the safe limit and bypass dedupe',
    '  --dedupe <seconds>  duplicate-print guard window, default 60, 0 disables',
    '  --font-size <pt>    text font size, default 10.5 (6-72)',
    '  --margin <mm>       page margin, default 20 (0-50)',
    '  --                  everything after it is input (text that starts with "-")',
    '',
    'Supported input: .txt .md .png .jpg .jpeg .pdf .docx .xlsx',
    'Blocked input:   .exe .bat .cmd .ps1 .msi .vbs .scr',
    'Exit codes: 0 ok, 2 argument, 3 printer, 4 render, 5 print, 6 rejected, 7 duplicate',
  ].join('\n');
}

function isPrintOptionToken(arg) {
  if (FLAG_OPTIONS.has(arg) || VALUE_OPTIONS.has(arg)) return true;
  const eq = arg.indexOf('=');
  if (eq > 2 && VALUE_OPTIONS.has(arg.slice(0, eq))) return true;
  return false;
}

// 'printer <file> ...' (print subcommand omitted) is accepted exactly like
// 'printer print <file> ...'. A leading option (-q, --json, ...) also means
// print. Anything else starting with '-' is left alone so 'printer --bogus'
// still reports 'unknown command' with exit 2.
//
// Leading options are also tolerated in front of an explicit command:
// 'printer -q url <url>' == 'printer url <url> -q'.
function splitLeadingOptions(argv) {
  const options = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (!arg.startsWith('-')) break;
    if (VALUE_OPTIONS.has(arg)) {
      if (i + 1 >= argv.length) return null;
      options.push(arg, argv[i + 1]);
      i += 2;
      continue;
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (FLAG_OPTIONS.has(arg) || (eq > 2 && VALUE_OPTIONS.has(arg.slice(0, eq)))) {
      options.push(arg);
      i += 1;
      continue;
    }
    return null;
  }
  return { options, rest: argv.slice(i) };
}

function normalizeArgv(argv) {
  if (argv.length === 0) return argv;
  const first = argv[0];
  if (first.startsWith('-')) {
    if (first === '--help' || first === '-h') return argv;
    if (first === '--') return ['print'].concat(argv);
    const split = splitLeadingOptions(argv);
    if (split && split.rest.length > 0 && (split.rest[0] === 'text' || split.rest[0] === 'url' || split.rest[0] === 'print')) {
      return [split.rest[0]].concat(split.options, split.rest.slice(1));
    }
    if (isPrintOptionToken(first)) return ['print'].concat(argv);
    return argv;
  }
  if (KNOWN_COMMANDS.has(first)) return argv;
  return ['print'].concat(argv);
}

function applyValueOption(options, name, value) {
  if (name === '--printer') options.printer = value;
  else if (name === '--copies') options.copiesRaw = value;
  else if (name === '--paper') options.paperRaw = value;
  else if (name === '--out') options.out = value;
  else if (name === '--dedupe') options.dedupeRaw = value;
  else if (name === '--font-size') options.fontSizeRaw = value;
  else if (name === '--fit-pages') options.fitPagesRaw = value;
  else if (name === '--margin') options.marginRaw = value;
}

function parsePrintArgs(args) {
  const options = {
    inputs: [],
    printer: null,
    copiesRaw: '1',
    paperRaw: 'A4',
    landscape: false,
    dryRun: false,
    json: false,
    quiet: false,
    force: false,
    forceFile: false,
    out: null,
    dedupeRaw: null,
    fontSizeRaw: null,
  fitPagesRaw: null,
    marginRaw: null,
    help: false,
  };
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (eq > 2 && VALUE_OPTIONS.has(arg.slice(0, eq))) {
      applyValueOption(options, arg.slice(0, eq), arg.slice(eq + 1));
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--fast' || arg === '--no-com') {
    // 跳过 Office COM（快，但版面按内容重排）；等价于 PRINTER_NO_COM=1
    options.fast = true;
  } else if (arg === '--landscape') {
      options.landscape = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--file') {
      options.forceFile = true;
    } else if (arg === '--quiet' || arg === '-q') {
      options.quiet = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (VALUE_OPTIONS.has(arg)) {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
        throw new CliError(EXIT.ARGUMENT, 'missing value for ' + arg);
      }
      applyValueOption(options, arg, args[i + 1]);
      i += 1;
    } else if (arg === '--') {
      // everything after '--' is input, even if it starts with '-'
      options.inputs.push.apply(options.inputs, args.slice(i + 1));
      break;
    } else if (arg.startsWith('-')) {
      throw new CliError(EXIT.ARGUMENT, 'unknown option: ' + arg);
    } else {
      options.inputs.push(arg);
    }
    i += 1;
  }
  return options;
}

function parseSimpleArgs(args) {
  const options = { json: false, help: false };
  for (const arg of args) {
    if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new CliError(EXIT.ARGUMENT, 'unknown option: ' + arg);
  }
  return options;
}

function parseCopies(raw) {
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new CliError(EXIT.ARGUMENT, '--copies must be a positive integer');
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1 || n > 50) {
    throw new CliError(EXIT.ARGUMENT, '--copies must be between 1 and 50');
  }
  return n;
}

function normalizePaper(raw) {
  const value = String(raw || '').trim().toLowerCase();
  const paper = PAPER_NAMES.get(value);
  if (!paper) {
    throw new CliError(EXIT.ARGUMENT, '--paper must be A4, A5 or Letter');
  }
  return paper;
}

function parseDedupeSeconds(raw) {
  if (raw === null || raw === undefined) return DEFAULT_DEDUPE_SECONDS;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new CliError(EXIT.ARGUMENT, '--dedupe must be a non-negative integer (seconds)');
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n > MAX_DEDUPE_SECONDS) {
    throw new CliError(EXIT.ARGUMENT, '--dedupe must be between 0 and ' + MAX_DEDUPE_SECONDS + ' seconds');
  }
  return n;
}

function validateInputFile(input) {
  if (!input) {
    throw new CliError(EXIT.ARGUMENT, 'missing input file');
  }
  const absolute = path.resolve(process.cwd(), input);
  const ext = path.extname(absolute).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new CliError(EXIT.REJECTED, 'blocked file type: ' + ext);
  }
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new CliError(EXIT.ARGUMENT, 'unsupported file type: ' + (ext || '(none)'));
  }
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch (error) {
    throw new CliError(EXIT.ARGUMENT, 'cannot access input file: ' + error.message);
  }
  if (!stat.isFile()) {
    throw new CliError(EXIT.ARGUMENT, 'input is not a regular file: ' + absolute);
  }
  if (stat.size === 0) {
    throw new CliError(EXIT.ARGUMENT, 'input file is empty: ' + absolute);
  }
  if (TEXT_EXTENSIONS.has(ext) && stat.size > MAX_TEXT_BYTES) {
    throw new CliError(EXIT.ARGUMENT, 'text file is larger than 20 MiB: ' + absolute);
  }
  if (DOC_EXTENSIONS.has(ext) && stat.size > MAX_DOC_BYTES) {
    throw new CliError(EXIT.ARGUMENT, 'document is larger than 200 MiB: ' + absolute);
  }
  return {
    absolute,
    extension: ext,
    kind: TEXT_EXTENSIONS.has(ext)
      ? 'text'
      : IMAGE_EXTENSIONS.has(ext)
        ? 'image'
        : DOC_EXTENSIONS.has(ext)
          ? 'doc'
          : null,
    bytes: stat.size,
  };
}

// --fit-pages：1..50，空表示不启用（自动缩字号把内容压进指定页数）
function resolveFitPages(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return 0;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new CliError(EXIT.ARGUMENT, '--fit-pages must be an integer between 1 and 50');
  }
  return n;
}

function resolveOutDir(options, config) {
  const raw = options.out || config.outputResolved || DEFAULT_OUT_DIR;
  const resolved = options.out ? path.resolve(process.cwd(), options.out) : raw;
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
    throw new CliError(EXIT.ARGUMENT, '--out is not a directory: ' + resolved);
  }
  return resolved;
}

function snippet(value, max = 24) {
  const flat = String(value).replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '...' : flat;
}

function itemLabel(item) {
  if (item.type === 'text') return 'text:' + snippet(item.text);
  if (item.type === 'url') return item.url;
  return item.path;
}

function looksLikeBareText(value) {
  const text = String(value);
  if (text.trim() === '') return false;
  if (isUrl(text)) return false;
  if (/[\\/]/.test(text)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return false;
  const ext = path.extname(text).toLowerCase();
  if (SUPPORTED_EXTENSIONS.has(ext) || BLOCKED_EXTENSIONS.has(ext)) return false;
  return true;
}

function classifyInput(raw, options) {
  if (!options.forceFile) {
    if (raw.startsWith('text:')) return { type: 'text', text: raw.slice('text:'.length), raw };
    if (raw.startsWith('url:')) return { type: 'url', url: raw.slice('url:'.length), raw };
  }
  return { type: 'file', path: raw, raw };
}

function resolveInputs(options, command) {
  const raw = options.inputs.slice();
  if (raw.length === 0) {
    throw new CliError(EXIT.ARGUMENT, 'missing input');
  }
  if (command === 'text') {
    if (options.forceFile) return raw.map((v) => ({ type: 'file', path: v, raw: v }));
    const joined = raw.join(' ');
    return [{ type: 'text', text: joined, raw: joined }];
  }
  if (command === 'url') {
    return raw.map((v) => ({ type: 'url', url: v, raw: v }));
  }
  const items = raw.map((v) => classifyInput(v, options));
  if (items.length === 1 && items[0].type === 'file' && !options.forceFile) {
    const single = items[0];
    if (!fs.existsSync(path.resolve(process.cwd(), single.path))) {
      if (isUrl(single.path)) {
        single.type = 'url';
        single.url = single.path;
      } else if (looksLikeBareText(single.path)) {
        single.type = 'text';
        single.text = single.path;
      }
    }
  }
  return items;
}

function formatPrintersText(printers, data) {
  const rows = printers.map((p) => [
    p.name,
    p.default ? '*' : '',
    p.status,
    p.whitelisted ? 'yes' : 'no',
  ]);
  rows.unshift(['NAME', 'DEFAULT', 'STATUS', 'WHITELIST']);
  const widths = [0, 0, 0, 0];
  for (const row of rows) {
    for (let i = 0; i < widths.length; i += 1) {
      widths[i] = Math.max(widths[i], String(row[i]).length);
    }
  }
  const lines = rows.map((row) =>
    row.map((cell, i) => (i === row.length - 1 ? String(cell) : String(cell).padEnd(widths[i] + 2))).join(''),
  );
  lines.push('');
  lines.push('* = Windows default printer (read-only; print-cli does not select it implicitly)');
  lines.push('config: ' + data.configPath + (data.configLoaded ? ' (loaded)' : ' (not found, built-in defaults)'));
  lines.push('whitelist: ' + data.whitelist.join(' | '));
  return lines.join('\n');
}

function formatStatusText(data) {
  return [
    'print-cli ' + data.version,
    'node: ' + data.node,
    'platform: ' + data.platform,
    'project: ' + data.projectRoot,
    'config: ' + data.configPath + (data.configLoaded ? ' (loaded)' : ' (not found, built-in defaults)'),
    'default printer: ' + data.defaultPrinter,
    'allowRealPrinter: ' + data.allowRealPrinter,
    'whitelist: ' + data.whitelist.join(' | '),
    'log dir: ' + data.logDir,
    'output dir: ' + data.outputDir,
    'supported: ' + data.supportedFormats.join(' '),
    'blocked: ' + data.blockedExtensions.join(' '),
    'dedupe: ' + data.dedupeWindowSeconds + 's (logs\\.dedupe.json)',
  ].join('\n');
}

function seconds(ms) {
  return (Number(ms || 0) / 1000).toFixed(1) + 's';
}

// 一行说清「这份文档走的是哪条路」：格式 / 路径 A|B / 解析器 / 页数 / 工作表
function docSummary(doc) {
  if (!doc) return '';
  const bits = [String(doc.format || '?'), 'path ' + String(doc.path || '?')];
  if (doc.source) bits.push(String(doc.source));
  if (doc.pages) bits.push(doc.pages + 'p');
  if (doc.estimatedPages && !doc.pages) bits.push('~' + doc.estimatedPages + 'p');
  if (doc.rows !== undefined && doc.rows !== null && doc.format === 'xlsx') bits.push(doc.rows + ' rows');
  if (doc.columns) bits.push(doc.columns + ' cols/' + doc.totalWidth + ' cells');
  if (doc.sheet) bits.push('sheet ' + doc.sheet + (doc.sheets && doc.sheets.length > 1 ? ' of ' + doc.sheets.length : ''));
  if (doc.pageSize) bits.push(doc.pageSize);
  return bits.join(' | ');
}

// 清理上次没删掉的临时目录：Edge 被杀后偶尔仍占用 profile，
// 导致 rmSync 失败、留下几十 MB 的 Chrome 用户数据。超过 30 分钟的直接尝试删掉。
function sweepStaleTempDirs(outDir, maxAgeMs = 30 * 60 * 1000) {
  const root = path.join(outDir, '_tmp');
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  const now = Date.now();
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('url-')) continue;
    const full = path.join(root, entry.name);
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs < maxAgeMs) continue;
      if (removeDirWithRetry(full, 2)) removed += 1;
    } catch { /* 占用中就先留着，下次再试 */ }
  }
  return removed;
}

function makeTempDir(outDir) {
  sweepStaleTempDirs(outDir);
  const dir = path.join(outDir, '_tmp', 'url-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Edge may still hold the profile directory for a moment after being killed,
// so a single rmSync can fail with EBUSY/EPERM. Retry briefly, then give up
// quietly: a leftover temp dir must never fail an otherwise good print.
function removeDirWithRetry(dir, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      sleepSync(150);
    }
  }
  return false;
}

function textBaseName(text) {
  const head = String(text).replace(/\s+/g, ' ').trim().slice(0, 20).replace(/[\\/:*?"<>|]/g, ' ');
  return 'text-' + (head || 'untitled');
}

async function executeItem(item, ctx) {
  const { options, printer, copies, paper, outDir, fontSize, fitPages, marginMm, urlMargin, dedupeSeconds, dedupeWindowMs, logDir } = ctx;
  let kind = null;
  let sourceFile = null;
  let baseName = null;
  let stdin = null;
  let imageListFile = null;
  let contentChunks = [];
  let contentHash = null;
  let textChars = null;
  let image = null;
  let urlInfo = null;
  let docInfo = null;
  let fontFamily = null;
  let jobMarginMm = marginMm;
  let landscape = Boolean(options.landscape);
  let tempDir = null;

  try {
    if (item.type === 'text') {
      const text = String(item.text);
      if (text.trim() === '') throw new CliError(EXIT.ARGUMENT, 'empty text input');
      if (text.length > MAX_TEXT_BYTES) throw new CliError(EXIT.ARGUMENT, 'text is larger than 20 MiB');
      const lines = prepareTextLines(text, { markdown: false });
      stdin = encodeStyledLines(lines);
      kind = 'text';
      contentChunks = [Buffer.from('text\n' + fontSize + '\n' + marginMm + '\n' + stdin, 'utf8')];
      baseName = textBaseName(text);
      sourceFile = baseName + '.txt';
      textChars = text.length;
    } else if (item.type === 'url') {
      if (!isUrl(item.url)) {
        throw new CliError(EXIT.ARGUMENT, 'URL must start with http:// or https://: ' + String(item.url));
      }
      tempDir = makeTempDir(outDir);
      const rendered = await renderUrl(item.url, tempDir);
      imageListFile = path.join(tempDir, 'pages.txt');
      fs.writeFileSync(imageListFile, rendered.pngs.join('\n'), 'utf8');
      kind = 'imageList';
      jobMarginMm = urlMargin;
      contentChunks = rendered.pngs.map((file) => fs.readFileSync(file));
      baseName = new URL(item.url).hostname.replace(/^www\./i, '') || 'url';
      sourceFile = baseName;
      urlInfo = {
        url: item.url,
        pages: rendered.pages,
        edgeMs: rendered.edgeMs,
        renderMs: rendered.ms,
      };
    } else {
      const input = validateInputFile(item.path);
      sourceFile = input.absolute;
      baseName = path.basename(input.absolute, path.extname(input.absolute));
      if (input.kind === 'text') {
        const lines = prepareFileLines(input.absolute);
        stdin = encodeStyledLines(lines);
        kind = 'text';
        contentChunks = [Buffer.from('text\n' + fontSize + '\n' + marginMm + '\n' + stdin, 'utf8')];
        textChars = lines.reduce((sum, line) => sum + line.text.length, 0);
      } else if (input.kind === 'image') {
        image = readImageInfo(input.absolute);
        kind = 'image';
        contentChunks = [fs.readFileSync(input.absolute)];
      } else {
        // PDF / DOCX / XLSX：统一交给 document.mjs 决定走位图还是文本链路
        const prepared = await prepareDocument(input, {
          paper,
          marginMm,
          fontPt: fontSize,
          landscapeFlag: options.landscape,
          force: options.force,
          dryRun: options.dryRun,
          comTimeoutMs: COM_TIMEOUT_MS,
          checkDuplicate: (hash, effectiveLandscape) => {
            if (options.dryRun || dedupeSeconds <= 0 || options.force) return;
            const key = buildKey({
              contentHash: hash,
              printer: printer.name,
              copies,
              paper,
              landscape: effectiveLandscape,
            });
            if (findRecent(logDir, key, dedupeWindowMs)) {
              throw new CliError(
                EXIT.DUPLICATE,
                dedupeSeconds + ' 秒内已打印过相同内容，如需重打加 --force',
              );
            }
          },
        });
        docInfo = prepared.doc;
        tempDir = prepared.tempDir;
        contentHash = prepared.contentHash;
        kind = prepared.kind;
        landscape = prepared.effectiveLandscape;
        fontFamily = prepared.fontFamily || null;
        // 位图链路自己就是整页图像，页边距必须 0；文本链路仍按 --margin（默认 20mm）。
        jobMarginMm = prepared.kind === 'text' ? marginMm : urlMargin;
        if (prepared.kind === 'text') {
          stdin = prepared.stdin;
          textChars = prepared.textChars;
        } else {
          imageListFile = prepared.imageListFile;
        }
      }
    }

    if (!contentHash) contentHash = hashChunks(contentChunks);
    const fingerprint = buildKey({
      contentHash,
      printer: printer.name,
      copies,
      paper,
      landscape,
    });

    if (!options.dryRun && dedupeSeconds > 0 && !options.force) {
      const hit = findRecent(logDir, fingerprint, dedupeWindowMs);
      if (hit) {
        throw new CliError(
          EXIT.DUPLICATE,
          dedupeSeconds + ' 秒内已打印过相同内容，如需重打加 --force',
        );
      }
    }

    if (options.dryRun) {
      return {
        ok: true,
        dryRun: true,
        label: itemLabel(item),
        inputType: item.type,
        file: item.type === 'text' ? null : sourceFile,
        kind,
        pages: 0,
        bytes: null,
        outputPdf: null,
        ms: 0,
        fingerprint,
        textChars,
        image,
        url: urlInfo,
        doc: docInfo,
        landscape,
        fontFamily,
      };
    }

    const job = runPrintJob({
      kind,
      file: sourceFile,
      printer: printer.name,
      copies,
      paper,
      landscape,
      outDir,
      baseName,
      stdin,
      imageListFile,
      fontPt: fontSize,
      marginMm: jobMarginMm,
      lineSpacing: DEFAULT_LINE_SPACING,
      fontFamily: fontFamily || '',
      fitPages,
    });

    if (dedupeSeconds > 0) {
      recordPrint(logDir, fingerprint, {
        printer: printer.name,
        copies,
        paper,
        pages: job.pages,
        label: itemLabel(item),
      });
    }

    return {
      ok: true,
      dryRun: false,
      label: itemLabel(item),
      inputType: item.type,
      file: item.type === 'text' ? null : sourceFile,
      kind,
      pages: job.pages,
      bytes: job.bytes,
      outputPdf: job.outputPdf,
      ms: job.jobMs,
      fingerprint,
      textChars,
      image,
      url: urlInfo,
      doc: docInfo,
      landscape,
      fontFamily,
      fontSizeUsed: job.fontSizeUsed,
      // --fit-pages 没达成目标页数：已照实打印，但要让调用方知道没压到要求页数
      fitMissed: fitPages > 0 && job.pages > fitPages
        ? { required: fitPages, actual: job.pages, fontSize: job.fontSizeUsed }
        : null,
      ps: job.psResult,
    };
  } finally {
    if (tempDir) {
      removeDirWithRetry(tempDir);
      // 只有 <outDir>\_tmp\<job> 这种自家目录才顺带收走空父目录；
      // 系统 TEMP 的父目录绝不碰。
      if (path.basename(path.dirname(tempDir)) === '_tmp') {
        try { fs.rmdirSync(path.dirname(tempDir)); } catch { /* still in use */ }
      }
    }
  }
}

async function handlePrint(command, args) {
  const out = {
    code: EXIT.OK,
    data: null,
    error: null,
    textOut: '',
    textErr: '',
    resultLine: '',
    quiet: false,
    logDir: null,
    logContext: {
      file: null,
      printer: null,
      copies: null,
      dryRun: null,
      pageCount: null,
      outputPdf: null,
    },
  };

  const options = parsePrintArgs(args);
  // --fast / --no-com：强制走 B 路径（跳过 Office COM），放在任何打印动作之前
  if (options.fast) process.env.PRINTER_NO_COM = '1';
  // --xlsx-scale 80|90|100|actual：控制 Excel 导出缩放，字太小就调大（可能分页）
  if (options.xlsxScale) process.env.PRINTER_XLSX_SCALE = String(options.xlsxScale);
  if (options.landscape) process.env.PRINTER_LANDSCAPE = '1';
  out.quiet = options.quiet;
  if (options.help) {
    out.textOut = helpText();
    return out;
  }

  const copies = parseCopies(options.copiesRaw);
  const paper = normalizePaper(options.paperRaw);
  const fontSize = options.fontSizeRaw === null ? DEFAULT_FONT_PT : clampFontSize(options.fontSizeRaw);
  const marginMm = options.marginRaw === null ? DEFAULT_MARGIN_MM : clampMarginMm(options.marginRaw);
  const dedupeSeconds = parseDedupeSeconds(options.dedupeRaw);
  const fitPages = resolveFitPages(options.fitPagesRaw);
  const items = resolveInputs(options, command);

  const config = loadConfig();
  out.logDir = config.loggingResolved;
  out.logContext.copies = copies;
  out.logContext.dryRun = options.dryRun;

  if (copies > config.limits.maxCopiesWithoutForce && !options.force) {
    throw new CliError(
      EXIT.ARGUMENT,
      'refusing ' + copies + ' copies without --force (safe limit is ' + config.limits.maxCopiesWithoutForce + ')',
    );
  }
  if (copies > config.limits.maxCopies) {
    throw new CliError(EXIT.ARGUMENT, 'copies exceed configured maximum of ' + config.limits.maxCopies);
  }

  // 快速通道：白名单命中就不枚举系统打印机（省 1~2 秒 PowerShell 启动）
  let printers = null;
  const quick = options.printer ? fastSelectPrinter(options.printer, config) : null;
  const printer = quick || selectPrinter(options.printer, config, (printers = listPrinters()));
  out.logContext.printer = printer.name;
  const outDir = resolveOutDir(options, config);

  const ctx = {
    options,
    printer,
    copies,
    paper,
    outDir,
    fontSize,
    fitPages,
    marginMm,
    urlMargin: options.marginRaw === null ? 0 : marginMm,
    dedupeSeconds,
    dedupeWindowMs: dedupeSeconds * 1000,
    logDir: config.loggingResolved,
  };

  const results = [];
  for (const item of items) {
    try {
      results.push(await executeItem(item, ctx));
    } catch (err) {
      const itemCode = err instanceof CliError ? err.exitCode : EXIT.PRINT;
      results.push({
        ok: false,
        label: itemLabel(item),
        inputType: item.type,
        pages: 0,
        ms: 0,
        error: { code: itemCode, message: messageOf(err) },
      });
    }
  }

  const total = results.length;
  const okResults = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const firstFail = failed[0] || null;
  const anyFitMissed = okResults.some((r) => r.fitMissed);
  out.code = firstFail ? firstFail.error.code : (anyFitMissed ? EXIT.ARGUMENT : EXIT.OK);

  const fitNote = anyFitMissed && failed.length === 0 ? ' (fit-pages 未达成)' : '';
  const summary = failed.length === 0
    ? 'OK ' + okResults.length + '/' + total + fitNote
    : 'OK ' + okResults.length + '/' + total + ' (' + failed.length + ' failed)' + fitNote;

  const printerName = printer.name;

  if (total === 1) {
    const only = results[0];
    if (!only.ok) {
      out.error = only.error;
      out.resultLine = 'ERR[' + only.error.code + '] ' + only.error.message;
      out.textErr = options.quiet
        ? out.resultLine
        : 'ERROR[' + only.error.code + ']: ' + only.error.message;
      out.logContext.pageCount = 0;
      return out;
    }
    const pages = only.pages;
    const onlyFlag = only.landscape ? ', landscape' : '';
    if (options.dryRun) {
      out.resultLine = 'DRY-RUN OK -> ' + printerName;
      const dry = [
        'DRY-RUN OK',
        'file: ' + (only.file || '(inline text, ' + (only.textChars || 0) + ' chars)') + ' (' + only.kind + ')',
        'printer: ' + printerName + ' (whitelisted)',
        'copies: ' + copies + ', paper: ' + paper + onlyFlag,
        'out: ' + outDir + ' (no file written)',
      ];
      if (only.doc) {
        dry.push('doc: ' + docSummary(only.doc));
        if (only.doc.note) dry.push('note: ' + only.doc.note);
      }
      out.textOut = dry.join('\n');
    } else {
      const sizeNote = fitPages > 0 && only.fontSizeUsed
        ? ' [字号 ' + only.fontSizeUsed + 'pt]'
        : '';
      if (only.fitMissed) {
        // 已经打出来了，但没压进要求页数：退出码 2，让调用方能判断“目标没达成”
        out.code = EXIT.ARGUMENT;
        out.resultLine = 'WARN[2] 已打印 ' + pages + 'p' + sizeNote
          + '，但没压进 ' + only.fitMissed.required + ' 页 -> ' + printerName;
      } else {
        out.resultLine = 'OK ' + pages + 'p ' + seconds(only.ms) + sizeNote + ' -> ' + printerName;
      }
      const lines = ['OK'];
      lines.push('file: ' + (only.file || '(inline text, ' + (only.textChars || 0) + ' chars)'));
      if (only.url) lines.push('url: ' + only.url.url + ' (edge ' + only.url.edgeMs + ' ms -> ' + pages + ' png page(s))');
      if (only.doc) lines.push('doc: ' + docSummary(only.doc));
      if (only.doc && only.doc.note) lines.push('note: ' + only.doc.note);
      lines.push('printer: ' + printerName);
      lines.push('pages: ' + pages + ', copies: ' + copies + ', paper: ' + paper + onlyFlag);
      lines.push(only.outputPdf ? 'pdf: ' + only.outputPdf : 'submitted to printer (no file output)');
      lines.push('elapsed: ' + only.ms + ' ms');
      out.textOut = lines.join('\n');
    }
    if (options.quiet) out.textOut = out.resultLine;

    out.data = {
      file: only.file,
      printer: printerName,
      copies,
      paper,
      landscape: Boolean(only.landscape),
      dryRun: options.dryRun,
      inputType: only.inputType,
      kind: only.kind,
      textChars: only.textChars,
      fontSize,
      marginMm,
      ps: only.ps || null,
      image: only.image || null,
      url: only.url || null,
      doc: only.doc || null,
      resultLine: out.resultLine,
    };
    if (only.fontFamily) out.data.fontFamily = only.fontFamily;
    // dry-run keeps its historical shape: no pages / bytes / outputPdf keys,
    // so a caller can prove that nothing was rendered.
    if (!options.dryRun) {
      out.data.pages = pages;
      out.data.bytes = only.bytes;
      out.data.outputPdf = only.outputPdf;
      out.data.jobMs = only.ms;
    }
    out.logContext.file = only.file;
    out.logContext.pageCount = pages;
    out.logContext.outputPdf = only.outputPdf;
    return out;
  }

  const lines = [];
  results.forEach((result, index) => {
    const prefix = '[' + (index + 1) + '/' + total + '] ';
    let line;
    if (result.ok) {
      line = 'OK ' + result.pages + 'p ' + seconds(result.ms) + ' -> ' + printerName;
    } else {
      line = 'ERR[' + result.error.code + '] ' + result.error.message;
    }
    lines.push(prefix + line + ' [' + result.label + ']');
  });
  lines.push(summary);
  out.textOut = lines.join('\n');
  out.resultLine = summary;
  if (failed.length > 0) {
    out.error = { code: firstFail.error.code, message: summary + ': ' + firstFail.error.message };
  }

  out.data = {
    printer: printerName,
    copies,
    paper,
    landscape: options.landscape,
    dryRun: options.dryRun,
    total,
    ok: okResults.length,
    failed: failed.length,
    summary,
    results: results.map((result) => ({
      label: result.label,
      inputType: result.inputType,
      ok: result.ok,
      pages: result.pages,
      ms: result.ms,
      bytes: result.bytes || null,
      outputPdf: result.outputPdf || null,
      doc: result.doc || null,
      error: result.error || null,
    })),
    resultLine: summary,
  };
  out.logContext.file = results.find((r) => r.file) ? results.find((r) => r.file).file : null;
  out.logContext.pageCount = okResults.reduce((sum, r) => sum + Number(r.pages || 0), 0);
  out.logContext.outputPdf = okResults.find((r) => r.outputPdf) ? okResults.find((r) => r.outputPdf).outputPdf : null;
  return out;
}

async function run() {
  const started = Date.now();
  const rawArgv = process.argv.slice(2);
  const argv = normalizeArgv(rawArgv);
  const wantsJson = argv.includes('--json');
  const quietFlag = argv.includes('-q') || argv.includes('--quiet');
  const command = argv[0] || 'help';
  let code = EXIT.OK;
  let data = null;
  let error = null;
  let textOut = '';
  let textErr = '';
  let resultLine = '';
  let logDir = LOG_DIR;
  let logContext = {
    file: null,
    printer: null,
    copies: null,
    dryRun: null,
    pageCount: null,
    outputPdf: null,
  };

  try {
    if (argv.length === 0 || command === 'help' || command === '--help' || command === '-h') {
      textOut = helpText();
    } else if (command === 'printers') {
      const options = parseSimpleArgs(argv.slice(1));
      if (options.help) {
        textOut = helpText();
      } else {
        const config = loadConfig();
        logDir = config.loggingResolved;
        const printers = annotatePrinters(listPrinters(), config);
        const defaultPrinter = systemDefaultPrinter(printers);
        data = {
          printers,
          defaultPrinter,
          configPath: CONFIG_PATH,
          configLoaded: config.loaded,
          whitelist: config.printers.allow,
          allowRealPrinter: config.printers.allowRealPrinter,
        };
        textOut = options.json ? '' : formatPrintersText(printers, data);
      }
    } else if (command === 'status') {
      const options = parseSimpleArgs(argv.slice(1));
      if (options.help) {
        textOut = helpText();
      } else {
        const config = loadConfig();
        logDir = config.loggingResolved;
        data = {
          version: CLI_VERSION,
          node: process.version,
          platform: process.platform,
          projectRoot: PROJECT_ROOT,
          configPath: CONFIG_PATH,
          configLoaded: config.loaded,
          defaultPrinter: config.printers.default,
          allowRealPrinter: config.printers.allowRealPrinter,
          whitelist: config.printers.allow,
          logDir: config.loggingResolved,
          outputDir: config.outputResolved,
          supportedFormats: [...SUPPORTED_EXTENSIONS],
          blockedExtensions: [...BLOCKED_EXTENSIONS],
          dedupeWindowSeconds: DEFAULT_DEDUPE_SECONDS,
        };
        textOut = options.json ? '' : formatStatusText(data);
      }
    } else if (command === 'print' || command === 'text' || command === 'url') {
      const handled = await handlePrint(command, argv.slice(1));
      code = handled.code;
      data = handled.data;
      error = handled.error;
      textOut = handled.textOut;
      textErr = handled.textErr;
      resultLine = handled.resultLine;
      logDir = handled.logDir || logDir;
      logContext = handled.logContext;
    } else {
      throw new CliError(EXIT.ARGUMENT, 'unknown command: ' + command);
    }
  } catch (err) {
    code = err instanceof CliError ? err.exitCode : EXIT.PRINT;
    error = {
      code,
      message: messageOf(err),
    };
    if (err instanceof CliError && err.details) error.details = err.details;
    resultLine = 'ERR[' + code + '] ' + messageOf(err);
    textErr = quietFlag ? resultLine : 'ERROR[' + code + ']: ' + messageOf(err);
  }

  const durationMs = Date.now() - started;
  const record = {
    timestamp: new Date(started).toISOString(),
    command,
    args: rawArgv,
    file: logContext.file,
    printer: logContext.printer,
    copies: logContext.copies,
    dryRun: logContext.dryRun,
    result: code === EXIT.OK ? (logContext.dryRun ? 'dry-run' : 'success') : 'error',
    exitCode: code,
    pageCount: logContext.pageCount,
    outputPdf: logContext.outputPdf,
    durationMs,
    error: error ? error.message : null,
  };
  try {
    appendPrintLog(logDir, record);
  } catch (logError) {
    textErr += (textErr ? '\n' : '') + 'WARN: JSONL log failed: ' + messageOf(logError);
  }

  if (wantsJson) {
    const envelope = {
      ok: code === EXIT.OK,
      command,
      data: error && !data ? null : data,
      error,
      durationMs,
      resultLine,
    };
    process.stdout.write(JSON.stringify(envelope) + '\n');
    if (textErr) process.stderr.write(textErr + '\n');
  } else if (quietFlag && textErr && !textOut) {
    // --quiet promises a single line; print the ERR line on stdout so it is
    // visible even when only stdout is captured.
    process.stdout.write(textErr + '\n');
  } else {
    if (textOut) process.stdout.write(textOut + '\n');
    if (textErr) process.stderr.write(textErr + '\n');
  }
  return code;
}

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write('FATAL: ' + (error && error.stack ? error.stack : String(error)) + '\n');
    process.exitCode = EXIT.PRINT;
  });
