import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CliError, EXIT } from './errors.mjs';
import { PS_DIR } from './py.mjs';
import { POWERSHELL, runPowerShellEncoded } from './ps.mjs';

// 路径 A（保格式）：Word / Excel COM 把 .docx / .xlsx 转成 PDF，再走 PDF 渲染。
// 必须保证 Quit() + ReleaseComObject，否则 WINWORD/EXCEL 残留并锁住文件。
// 90 秒没完成：调用方结束 powershell，再按脚本报告的 P1_COM_PID 结束 Office。

export const OFFICE_SCRIPT = path.join(PS_DIR, 'office-to-pdf.ps1');
export const COM_TIMEOUT_MS = 90000;

const PROG_IDS = {
  word: 'Word.Application',
  excel: 'Excel.Application',
};

const probeCache = new Map();

export function comAvailable(kind) {
  const progId = PROG_IDS[kind];
  if (!progId) return false;
  if (probeCache.has(kind)) return probeCache.get(kind);
  if (String(process.env.PRINTER_NO_COM || '') === '1') {
    probeCache.set(kind, false);
    return false;
  }
  const script = "$id = '" + progId + "'\n[void][type]::GetTypeFromProgID($id)\n" +
    "if ([type]::GetTypeFromProgID($id)) { '1' } else { '0' }";
  const result = runPowerShellEncoded(script, { timeoutMs: 20000 });
  const ok = result.status === 0 && String(result.stdout).trim().indexOf('1') === 0;
  probeCache.set(kind, ok);
  return ok;
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

function killProcess(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return;
  try {
    spawnSync('taskkill', ['/PID', String(id), '/F'], { windowsHide: true, timeout: 15000, stdio: 'ignore' });
  } catch {
    // best effort: the caller still reports the timeout
  }
}

function parseMarker(stdout, prefix) {
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const text = line.trim();
    if (text.startsWith(prefix)) return text.slice(prefix.length);
  }
  return null;
}

export function convertWithOffice(options) {
  const { kind, file, outputPdf, firstSheetOnly = false, timeoutMs = COM_TIMEOUT_MS } = options;
  assertScriptBom(OFFICE_SCRIPT);
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    OFFICE_SCRIPT,
    '-Kind',
    kind === 'excel' ? 'Excel' : 'Word',
    '-InputFile',
    file,
    '-OutputPdf',
    outputPdf,
  ];
  if (firstSheetOnly) args.push('-FirstSheetOnly');
  // 纸张方向跟随本次打印方向，否则竖版导出印到横版纸上会只占半页宽
  if (String(process.env.PRINTER_LANDSCAPE || '') === '1') args.push('-Landscape');

  const started = Date.now();
  const result = spawnSync(POWERSHELL, args, {
    encoding: 'buffer',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  const ms = Date.now() - started;
  const stdout = result.stdout ? result.stdout.toString('utf8') : '';
  const stderr = result.stderr ? result.stderr.toString('utf8') : '';

  if (result.error && result.error.code === 'ETIMEDOUT') {
    const comPid = parseMarker(stdout, 'P1_COM_PID:');
    killProcess(comPid);
    const secs = timeoutMs >= 1000 ? String(Math.round(timeoutMs / 1000)) : (timeoutMs / 1000).toFixed(1);
    throw new CliError(
      EXIT.RENDER,
      (kind === 'excel' ? 'Excel' : 'Word') + ' COM 转换超过 ' + secs +
        ' 秒，已强制结束' + (comPid ? '（pid ' + comPid + '）' : '') + '：' + path.basename(file),
    );
  }
  if (result.error) {
    throw new CliError(EXIT.RENDER, '无法启动 PowerShell: ' + result.error.message);
  }
  if (result.status !== 0) {
    const detail = (stderr || stdout).replace(/\s+/g, ' ').trim();
    throw new CliError(
      EXIT.RENDER,
      (kind === 'excel' ? 'Excel' : 'Word') + ' COM 转换失败（exit ' + result.status + '）: ' + detail.slice(0, 500),
    );
  }
  if (!fs.existsSync(outputPdf) || fs.statSync(outputPdf).size === 0) {
    throw new CliError(EXIT.RENDER, 'Office 没有产出 PDF: ' + outputPdf);
  }
  return { outputPdf, bytes: fs.statSync(outputPdf).size, ms, stdout: stdout.trim() };
}
