import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const POWERSHELL = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

export function decodePowerShellBuffer(buffer) {
  if (!buffer || buffer.length === 0) return '';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  let zeros = 0;
  const sample = Math.min(buffer.length, 200);
  for (let i = 1; i < sample; i += 2) {
    if (buffer[i] === 0) zeros += 1;
  }
  if (sample > 10 && zeros / Math.ceil(sample / 2) > 0.6) {
    return buffer.toString('utf16le');
  }
  return buffer.toString('utf8');
}

export function runPowerShellEncoded(script, options = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync(
    POWERSHELL,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded,
    ],
    {
      encoding: 'buffer',
      windowsHide: true,
      timeout: options.timeoutMs ?? 30000,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      env: { ...process.env, ...(options.env || {}) },
    },
  );
  return {
    status: result.status,
    signal: result.signal,
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    error: result.error || null,
    stdout: decodePowerShellBuffer(result.stdout),
    stderr: decodePowerShellBuffer(result.stderr),
  };
}
