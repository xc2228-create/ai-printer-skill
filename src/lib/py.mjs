import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CliError, EXIT } from './errors.mjs';
import { PROJECT_ROOT } from './config.mjs';

// 零依赖约束：不装 npm 包，Python 只用来做本机已有的三件事
//   1) render-pdf.py   pymupdf 渲染 PDF 页面（网页 / PDF / Office 转出的 PDF）
//   2) docx-text.py    python-docx（缺失时退回 zip+ElementTree）
//   3) xlsx-text.py    openpyxl（缺失时退回 zip+ElementTree）
// 用户机没有 Python 时不会静默降级成错东西，而是给出可执行的错误提示。

export const PS_DIR = path.join(PROJECT_ROOT, 'src', 'ps');
export const RENDER_SCRIPT = path.join(PS_DIR, 'render-pdf.py');
export const DOCX_SCRIPT = path.join(PS_DIR, 'docx-text.py');
export const XLSX_SCRIPT = path.join(PS_DIR, 'xlsx-text.py');

const PYTHON_CANDIDATES = [process.env.PRINTER_PYTHON, 'python', 'python3', 'py'].filter(Boolean);
const PYTHON_PROBE = "import sys\nif sys.version_info[0] < 3:\n    raise SystemExit(1)\nprint('ok')";
const DEFAULT_TIMEOUT_MS = 120000;

let cachedPython = null;

function probe(exe, prefix) {
  const result = spawnSync(exe, prefix.concat(['-c', PYTHON_PROBE]), {
    encoding: 'buffer',
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONWARNINGS: 'ignore' },
  });
  return !result.error && result.status === 0;
}

export function findPython() {
  if (cachedPython) return cachedPython;
  for (const candidate of PYTHON_CANDIDATES) {
    const isLauncher = /(^|[\\/])py(\.exe)?$/i.test(candidate);
    const prefix = isLauncher ? ['-3'] : [];
    if (probe(candidate, prefix)) {
      cachedPython = { exe: candidate, prefix };
      return cachedPython;
    }
  }
  throw new CliError(
    EXIT.RENDER,
    '需要 Python 3（本机未找到可用的 python）；PDF/DOCX/XLSX 的渲染与解析都依赖它',
  );
}

function pythonEnv() {
  return { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONWARNINGS: 'ignore' };
}

// 运行 src/ps 下的脚本并解析它打印的最后一个 JSON 行。
// 失败时把 stderr 的尾部拼进 CliError，方便用户看到真正的原因。
export function runPythonScript(scriptPath, args, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const python = findPython();
  const result = spawnSync(python.exe, python.prefix.concat([scriptPath]).concat(args), {
    encoding: 'buffer',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: pythonEnv(),
  });
  const stdout = result.stdout ? result.stdout.toString('utf8').trim() : '';
  const stderr = result.stderr ? result.stderr.toString('utf8').trim() : '';
  const label = options.label || path.basename(scriptPath);
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new CliError(EXIT.RENDER, label + ' 超时（' + Math.round(timeoutMs / 1000) + ' 秒）');
    }
    throw new CliError(EXIT.RENDER, '无法运行 Python: ' + result.error.message);
  }
  if (result.status !== 0) {
    // 只取最后一条非空行：Python 的 traceback 前几行都是路径噪音，
    // 真正的异常名（如 zipfile.BadZipFile: File is not a zip file）在最后。
    const lines = (stderr || stdout || 'no output').split(/\r?\n/).filter(function (line) { return line.trim() !== ''; });
    const detail = lines.length ? lines[lines.length - 1].trim() : 'no output';
    throw new CliError(EXIT.RENDER, label + ' 失败（exit ' + result.status + '）: ' + detail.slice(0, 400));
  }
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line.charAt(0) === '{') {
      try {
        return { parsed: JSON.parse(line), stdout, stderr };
      } catch {
        // keep scanning upwards
      }
    }
  }
  throw new CliError(EXIT.RENDER, label + ' 输出无法解析: ' + (stdout || 'empty').slice(0, 400));
}
