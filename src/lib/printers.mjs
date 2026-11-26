import { CliError, EXIT } from './errors.mjs';
import { runPowerShellEncoded } from './ps.mjs';

const STATUS_NAMES = {
  1: 'Other',
  2: 'Unknown',
  3: 'Idle',
  4: 'Printing',
  5: 'Warmup',
  6: 'Stopped',
  7: 'Offline',
};

const PRIMARY_SCRIPT = [
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
  "$ErrorActionPreference = 'Stop'",
  '$defaults = @(Get-CimInstance Win32_Printer | Where-Object { $_.Default } | ForEach-Object { $_.Name })',
  '$items = @(Get-Printer | ForEach-Object {',
  '  [pscustomobject]@{',
  '    name = [string]$_.Name',
  '    status = [string]$_.PrinterStatus',
  '    type = [string]$_.Type',
  '    driver = [string]$_.DriverName',
  '    default = [bool]($defaults -contains $_.Name)',
  '  }',
  '})',
  '[pscustomobject]@{ printers = $items } | ConvertTo-Json -Depth 5 -Compress',
].join('\n');

const FALLBACK_SCRIPT = [
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
  "$ErrorActionPreference = 'Stop'",
  '$items = @(Get-CimInstance Win32_Printer | ForEach-Object {',
  '  [pscustomobject]@{',
  '    name = [string]$_.Name',
  '    status = [string]$_.PrinterStatus',
  '    type = $(if ($_.Local) { "Local" } elseif ($_.Network) { "Network" } else { "Unknown" })',
  '    driver = [string]$_.DriverName',
  '    default = [bool]$_.Default',
  '  }',
  '})',
  '[pscustomobject]@{ printers = $items } | ConvertTo-Json -Depth 5 -Compress',
].join('\n');

function parsePrinterJson(stdout) {
  const text = String(stdout || '').replace(/^\uFEFF/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('PowerShell did not return printer JSON');
  }
  const parsed = JSON.parse(text.slice(start, end + 1));
  const list = Array.isArray(parsed.printers) ? parsed.printers : parsed.printers ? [parsed.printers] : [];
  return list.map((p) => {
    const rawStatus = String(p.status ?? '').trim();
    const status = STATUS_NAMES[rawStatus] || rawStatus || 'Unknown';
    return {
      name: String(p.name),
      status,
      type: String(p.type || 'Unknown'),
      driver: String(p.driver || ''),
      default: Boolean(p.default),
    };
  });
}

export function listPrinters() {
  let result = runPowerShellEncoded(PRIMARY_SCRIPT, { timeoutMs: 25000 });
  if (result.status !== 0 || result.timedOut) {
    const firstError = result.stderr.trim() || result.error?.message || 'Get-Printer failed';
    result = runPowerShellEncoded(FALLBACK_SCRIPT, { timeoutMs: 25000 });
    if (result.status !== 0 || result.timedOut) {
      const secondError = result.stderr.trim() || result.error?.message || 'Win32_Printer failed';
      throw new CliError(
        EXIT.PRINT,
        `cannot enumerate printers (Get-Printer: ${firstError}; WMI: ${secondError})`,
      );
    }
  }
  try {
    const printers = parsePrinterJson(result.stdout);
    if (printers.length === 0) {
      throw new Error('printer list is empty');
    }
    return printers;
  } catch (error) {
    throw new CliError(EXIT.PRINT, `cannot parse printer list: ${error.message}`);
  }
}

export function isVirtualPrinter(name) {
  const n = String(name).toLowerCase();
  return (
    n.includes('microsoft print to pdf') ||
    n.includes('microsoft xps document writer') ||
    n.includes('anydesk') ||
    n.includes('fax')
  );
}

export function isRealPrinter(name, config) {
  if (config.printers.realPrinters.some((x) => x.toLowerCase() === String(name).toLowerCase())) {
    return true;
  }
  return !isVirtualPrinter(name);
}

export function whitelistDecision(name, config) {
  if (/fax/i.test(name)) {
    return { allowed: false, reason: 'Fax printers are blocked by safety rule' };
  }
  const inAllow = config.printers.allow.some(
    (x) => x.toLowerCase() === String(name).toLowerCase(),
  );
  if (!inAllow) {
    return { allowed: false, reason: 'printer is not in config whitelist' };
  }
  if (isRealPrinter(name, config) && !config.printers.allowRealPrinter) {
    return { allowed: false, reason: 'real printers are disabled by allowRealPrinter=false' };
  }
  return { allowed: true, reason: 'in config whitelist' };
}

export function annotatePrinters(printers, config) {
  return printers.map((p) => {
    const decision = whitelistDecision(p.name, config);
    return {
      ...p,
      real: isRealPrinter(p.name, config),
      whitelisted: decision.allowed,
      whitelistReason: decision.reason,
    };
  });
}

export function hasTestModeGuard() {
  return process.env.P1_TEST_MODE === '1';
}

export function assertPrinterAllowed(requestedName, config, printers, options = {}) {
  const requested = String(requestedName || '').trim();
  if (!requested) {
    throw new CliError(EXIT.ARGUMENT, 'printer name is empty');
  }
  if (/fax/i.test(requested)) {
    throw new CliError(EXIT.REJECTED, 'Fax printers are blocked by safety rule');
  }
  const actual = printers.find((p) => p.name.toLowerCase() === requested.toLowerCase());
  if (!actual) {
    throw new CliError(EXIT.PRINTER, `printer not found: ${requested}`);
  }
  const decision = whitelistDecision(actual.name, config);
  if (!decision.allowed) {
    throw new CliError(EXIT.PRINTER, `printer rejected: ${actual.name} (${decision.reason})`);
  }
  if (/xps document writer/i.test(actual.name)) {
    throw new CliError(EXIT.REJECTED, 'Microsoft XPS Document Writer is not supported in P1');
  }
  if (options.enforceTestMode !== false && hasTestModeGuard() && !/^microsoft print to pdf$/i.test(actual.name)) {
    throw new CliError(
      EXIT.REJECTED,
      `P1_TEST_MODE only allows Microsoft Print to PDF, refused: ${actual.name}`,
    );
  }
  return actual;
}

// 快速通道：名字已在白名单里时不必枚举系统打印机（省 1~2 秒 PowerShell 启动）
// 返回 null 表示「不能确定」，调用方应退回完整枚举以获得准确报错
export function fastSelectPrinter(requestedName, config, options = {}) {
  const requested = String(requestedName || '').trim();
  if (!requested) return null;
  if (/fax/i.test(requested)) return null;                 // 交给完整路径给准确报错
  if (/xps document writer/i.test(requested)) return null;
  if (!whitelistDecision(requested, config).allowed) return null;
  if (options.enforceTestMode !== false && hasTestModeGuard() && !/^microsoft print to pdf$/i.test(requested)) {
    return null;                                           // 测试模式下的越界也要走完整路径报错
  }
  const real = isRealPrinter(requested, config);
  return {
    name: requested,
    status: 'Unknown',
    type: 'Local',
    driver: '',
    default: false,
    real,
    whitelisted: true,
    whitelistReason: 'in config whitelist (fast path)',
  };
}

export function selectPrinter(explicitName, config, printers) {
  const name = explicitName || config.printers.default;
  if (!name) {
    throw new CliError(EXIT.ARGUMENT, 'no printer selected and config has no default printer');
  }
  return assertPrinterAllowed(name, config, printers);
}

export function systemDefaultPrinter(printers) {
  return printers.find((p) => p.default)?.name || null;
}
