import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CliError, EXIT } from './errors.mjs';
import { PROJECT_ROOT } from './config.mjs';
import { POWERSHELL, decodePowerShellBuffer } from './ps.mjs';

export const PS_DIR = path.join(PROJECT_ROOT, 'src', 'ps');
export const TEXT_SCRIPT = path.join(PS_DIR, 'print-text.ps1');
export const IMAGE_SCRIPT = path.join(PS_DIR, 'print-image.ps1');
export const JOB_TIMEOUT_MS = 120000;

export function isPdfPrinter(name) {
  return /pdf/i.test(String(name));
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

function timestamp(date = new Date()) {
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    '-' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds()) +
    '-' +
    pad(date.getMilliseconds(), 3)
  );
}

export function safeStem(value) {
  const stem = path.basename(String(value), path.extname(String(value)));
  const cleaned = stem
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 80);
  return cleaned || 'print';
}

export function makePdfOutputPath(outDir, sourceFile, date = new Date(), baseName = null) {
  fs.mkdirSync(outDir, { recursive: true });
  const stem = baseName ? safeStem(baseName) : safeStem(sourceFile);
  const base = stem + '-' + timestamp(date);
  let candidate = path.join(outDir, base + '.pdf');
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(outDir, base + '-' + suffix + '.pdf');
    suffix += 1;
  }
  return candidate;
}

function assertScriptBom(scriptPath) {
  let head;
  try {
    head = fs.readFileSync(scriptPath).subarray(0, 3);
  } catch (error) {
    throw new CliError(EXIT.RENDER, 'cannot read PowerShell script: ' + error.message);
  }
  if (!(head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf)) {
    throw new CliError(EXIT.RENDER, 'PowerShell script is missing UTF-8 BOM: ' + scriptPath);
  }
}

function parseResult(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line.startsWith('P1_RESULT:')) {
      return JSON.parse(line.slice('P1_RESULT:'.length));
    }
  }
  return null;
}

function errorText(result) {
  const pieces = [];
  const stderr = String(result.stderr || '').trim();
  const stdout = String(result.stdout || '').trim();
  if (stderr) pieces.push(stderr);
  if (stdout) pieces.push(stdout.split(/\r?\n/).slice(-6).join(' | '));
  const text = pieces.join(' || ').replace(/\s+/g, ' ').trim();
  return text.length > 2000 ? text.slice(0, 2000) + '...' : text;
}

// kind: 'text'  -> stdin carries the styled text, print-text.ps1 lays it out
//       'image' -> one image, one page
//       'imageList' -> one image per page (URL pages rendered by pymupdf)
export function runPrintJob(options) {
  const {
    kind,
    file,
    printer,
    copies,
    paper,
    landscape,
    outDir,
    baseName,
    stdin,
    imageListFile,
    fontPt = 10.5,
    marginMm = 20,
    lineSpacing = 1.5,
    fontFamily = '',
    fitPages = 0,
  } = options;

  if (kind !== 'text' && kind !== 'image' && kind !== 'imageList') {
    throw new CliError(EXIT.ARGUMENT, 'unsupported print job kind: ' + kind);
  }
  const scriptPath = kind === 'text' ? TEXT_SCRIPT : IMAGE_SCRIPT;
  assertScriptBom(scriptPath);

  const pdfPrinter = isPdfPrinter(printer);
  let outputPdf = null;
  if (pdfPrinter) {
    outputPdf = makePdfOutputPath(outDir, file || 'print', new Date(), baseName || file || 'print');
  }

  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-PrinterName',
    printer,
    '-Paper',
    paper,
    '-Copies',
    String(copies),
  ];
  if (landscape) args.push('-Landscape');
  if (outputPdf) args.push('-OutputPdf', outputPdf);

  if (kind === 'text') {
    args.push(
      '-InputFile',
      file || 'text.txt',
      '-FontSize',
      String(fontPt),
      '-MarginMm',
      String(marginMm),
      '-LineSpacing',
      String(lineSpacing),
    );
    // 表格必须用等宽中西文混排（宋体/新宋体），否则列对不齐。
    if (fontFamily) args.push('-FontFamily', fontFamily);
    // 自动缩字号适配页数（「打在一张纸上」不用再手试参数）
    if (fitPages > 0) args.push('-FitPages', String(fitPages));
  } else if (kind === 'image') {
    args.push('-InputFile', file, '-MarginMm', String(marginMm));
  } else {
    args.push('-InputFileList', imageListFile, '-MarginMm', String(marginMm));
    if (file) args.push('-InputFile', path.basename(file));
  }

  const started = Date.now();
  const spawnOptions = {
    encoding: 'buffer',
    windowsHide: true,
    timeout: JOB_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env },
  };
  if (kind === 'text') {
    if (process.env.PRINTER_DUMP_STDIN) {
      try { fs.writeFileSync(process.env.PRINTER_DUMP_STDIN, String(stdin || ''), 'utf8'); } catch { /* debug only */ }
    }
    spawnOptions.input = Buffer.from(String(stdin || ''), 'utf8');
  }
  const result = spawnSync(POWERSHELL, args, spawnOptions);
  const jobMs = Date.now() - started;

  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new CliError(EXIT.PRINT, 'PowerShell print job timed out after ' + Math.round(JOB_TIMEOUT_MS / 1000) + ' seconds');
    }
    throw new CliError(EXIT.PRINT, 'cannot start PowerShell: ' + result.error.message);
  }

  const stdout = decodePowerShellBuffer(result.stdout);
  const stderr = decodePowerShellBuffer(result.stderr);
  if (result.status === EXIT.RENDER || result.status === EXIT.PRINT) {
    const details = errorText({ stdout, stderr });
    throw new CliError(result.status, 'PowerShell print job failed (exit ' + result.status + '): ' + details);
  }
  if (result.status !== 0) {
    const details = errorText({ stdout, stderr });
    throw new CliError(EXIT.PRINT, 'PowerShell print job failed (exit ' + result.status + '): ' + details);
  }

  let psResult;
  try {
    psResult = parseResult(stdout);
  } catch (error) {
    throw new CliError(EXIT.PRINT, 'cannot parse PowerShell result: ' + error.message);
  }
  if (!psResult) {
    throw new CliError(EXIT.PRINT, 'PowerShell returned no result marker: ' + errorText({ stdout, stderr }));
  }

  let bytes = null;
  if (outputPdf) {
    if (!fs.existsSync(outputPdf)) {
      throw new CliError(EXIT.PRINT, 'PDF was not created: ' + outputPdf);
    }
    bytes = fs.statSync(outputPdf).size;
    if (!bytes) {
      throw new CliError(EXIT.PRINT, 'PDF is empty: ' + outputPdf);
    }
  }

  return {
    outputPdf,
    bytes,
    pages: Number(psResult.pages || 0),
    fontSizeUsed: Number(psResult.fontSizeUsed || 0) || null,
    psResult,
    jobMs,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}
