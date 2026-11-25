import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { CliError, EXIT } from './errors.mjs';
import { PROJECT_ROOT } from './config.mjs';

// Headless Edge prints the page to PDF; PyMuPDF then rasterises every page to a
// 200 dpi PNG so the normal image printing path can send it to the printer.
// The msedge launcher returns before the PDF exists, so the only trustworthy
// signal is the file itself: poll it, never the exit code.

const RENDER_SCRIPT = path.join(PROJECT_ROOT, 'src', 'ps', 'render-pdf.py');
const PDF_TIMEOUT_MS = 60000;
const RENDER_TIMEOUT_MS = 120000;
const PNG_DPI = 200;

const EDGE_CANDIDATES = [
  process.env.PRINTER_EDGE,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const PYTHON_CANDIDATES = [process.env.PRINTER_PYTHON, 'python', 'python3', 'py'].filter(Boolean);

const PYTHON_PROBE = [
  "import warnings; warnings.filterwarnings('ignore')",
  'try:',
  '    import pymupdf',
  'except ImportError:',
  '    import fitz',
  "print('ok')",
].join('\n');

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

export function isUrl(value) {
  return /^https?:\/\/\S+$/i.test(String(value || '').trim());
}

export function findEdge() {
  for (const candidate of EDGE_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // keep looking
    }
  }
  throw new CliError(
    EXIT.RENDER,
    '找不到 Microsoft Edge（可用 PRINTER_EDGE 环境变量指定 msedge.exe 的完整路径）',
  );
}

function pythonProbeOk(exe, prefix) {
  const result = spawnSync(exe, prefix.concat(['-c', PYTHON_PROBE]), {
    encoding: 'buffer',
    windowsHide: true,
    timeout: 25000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONWARNINGS: 'ignore' },
  });
  return !result.error && result.status === 0;
}

export function findPython() {
  for (const candidate of PYTHON_CANDIDATES) {
    const isLauncher = /(^|[\\/])py(\.exe)?$/i.test(candidate);
    const prefix = isLauncher ? ['-3'] : [];
    if (pythonProbeOk(candidate, prefix)) return { exe: candidate, prefix };
  }
  throw new CliError(
    EXIT.RENDER,
    '打印 URL 需要 Python 3 + pymupdf（pip install pymupdf）；当前未找到可用的 Python 或 pymupdf',
  );
}

export async function printUrlToPdf(url, workDir, options = {}) {
  const timeoutMs = options.timeoutMs || PDF_TIMEOUT_MS;
  const edge = findEdge();
  const pdfPath = path.join(workDir, 'page.pdf');
  const profileDir = path.join(workDir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    '--headless',
    '--disable-gpu',
    '--no-margins',
    '--no-pdf-header-footer',
    '--disable-extensions',
    '--user-data-dir=' + profileDir,
    '--print-to-pdf=' + pdfPath,
    url,
  ];

  const child = spawn(edge, args, { windowsHide: true, stdio: 'ignore' });
  let spawnError = null;
  let exited = false;
  child.on('error', function (error) { spawnError = error; exited = true; });
  child.on('exit', function () { exited = true; });

  const started = Date.now();
  let stableSize = -1;
  try {
    while (Date.now() - started < timeoutMs) {
      if (spawnError) {
        throw new CliError(EXIT.RENDER, '无法启动 Edge 无头渲染: ' + spawnError.message);
      }
      if (fs.existsSync(pdfPath)) {
        const size = fs.statSync(pdfPath).size;
        if (size > 0) {
          if (stableSize === size) {
            const head = fs.readFileSync(pdfPath).subarray(0, 5).toString('latin1');
            if (head === '%PDF-') {
              return { pdfPath, edge, bytes: size, ms: Date.now() - started };
            }
          }
          stableSize = size;
        }
      }
      await sleep(200);
    }
  } finally {
    if (!exited) {
      try { child.kill(); } catch { /* already gone */ }
      // Wait for msedge to really exit: its --user-data-dir is inside the
      // caller's temp dir and an open handle would block cleanup.
      const killDeadline = Date.now() + 5000;
      while (!exited && Date.now() < killDeadline) {
        await sleep(100);
      }
    }
  }
  throw new CliError(
    EXIT.RENDER,
    'Edge 无头渲染超时（' + Math.round(timeoutMs / 1000) + ' 秒）：' + url,
  );
}

export function pdfToPngs(pdfPath, workDir, options = {}) {
  const dpi = options.dpi || PNG_DPI;
  if (!fs.existsSync(RENDER_SCRIPT)) {
    throw new CliError(EXIT.RENDER, '缺少 PDF 渲染脚本: ' + RENDER_SCRIPT);
  }
  const python = findPython();
  const result = spawnSync(python.exe, python.prefix.concat([RENDER_SCRIPT, pdfPath, workDir, String(dpi)]), {
    encoding: 'buffer',
    windowsHide: true,
    timeout: RENDER_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONWARNINGS: 'ignore' },
  });
  const stderr = result.stderr ? result.stderr.toString('utf8').trim() : '';
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new CliError(EXIT.RENDER, 'pymupdf 渲染超时（' + Math.round(RENDER_TIMEOUT_MS / 1000) + ' 秒）');
    }
    throw new CliError(EXIT.RENDER, '无法运行 Python: ' + result.error.message);
  }
  if (result.status !== 0) {
    throw new CliError(EXIT.RENDER, 'pymupdf 渲染失败（exit ' + result.status + '）: ' + (stderr || 'no stderr').slice(0, 600));
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.toString('utf8').trim());
  } catch (error) {
    throw new CliError(EXIT.RENDER, 'pymupdf 输出无法解析: ' + error.message);
  }
  const pngs = (parsed.images || [])
    .map(function (image) { return image.path; })
    .filter(function (file) { return fs.existsSync(file) && fs.statSync(file).size > 0; });
  if (pngs.length === 0) {
    throw new CliError(EXIT.RENDER, 'pymupdf 没有渲染出任何页面');
  }
  return { pages: pngs.length, pngs, dpi, screenshotPdfPages: parsed.pages };
}

export async function renderUrl(url, workDir, options = {}) {
  const started = Date.now();
  const pdf = await printUrlToPdf(url, workDir, options);
  const rendered = pdfToPngs(pdf.pdfPath, workDir, { dpi: PNG_DPI });
  return {
    pdfPath: pdf.pdfPath,
    pages: rendered.pages,
    pngs: rendered.pngs,
    dpi: rendered.dpi,
    edge: pdf.edge,
    edgeMs: pdf.ms,
    ms: Date.now() - started,
  };
}
