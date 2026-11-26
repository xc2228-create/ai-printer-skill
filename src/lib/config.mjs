import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, EXIT } from './errors.mjs';

export const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SRC_DIR, '..', '..');
export const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');
export const EXAMPLE_CONFIG_PATH = path.join(PROJECT_ROOT, 'config.example.json');
export const LOG_DIR = path.join(PROJECT_ROOT, 'logs');
export const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, 'test-out');

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  printers: {
    // 默认只允许 PDF 打印机，避免装完就误打真机。
    // 要用自己的打印机：把它加进 allow（名字必须与 Get-Printer 里的完全一致），
    // 并把真机加进 realPrinters（用于区分“会不会耗纸”）。
    allow: ['Microsoft Print to PDF'],
    default: 'Microsoft Print to PDF',
    allowRealPrinter: true,
    realPrinters: [],
  },
  limits: {
    maxCopiesWithoutForce: 5,
    maxCopies: 50,
  },
  output: { dir: 'test-out' },
  logging: { dir: 'logs' },
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeRelativeDir(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CliError(EXIT.ARGUMENT, `config: ${field} must be a non-empty string`);
  }
  const resolved = path.resolve(PROJECT_ROOT, value);
  const rel = path.relative(PROJECT_ROOT, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new CliError(EXIT.ARGUMENT, `config: ${field} must stay inside the project directory`);
  }
  return resolved;
}

function normalizeConfig(raw) {
  const cfg = clone(DEFAULT_CONFIG);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError(EXIT.ARGUMENT, 'config: root must be a JSON object');
  }

  const printers = raw.printers;
  if (printers !== undefined) {
    if (!printers || typeof printers !== 'object' || Array.isArray(printers)) {
      throw new CliError(EXIT.ARGUMENT, 'config: printers must be an object');
    }
    if (printers.allow !== undefined) {
      if (!Array.isArray(printers.allow)) {
        throw new CliError(EXIT.ARGUMENT, 'config: printers.allow must be an array');
      }
      cfg.printers.allow = printers.allow
        .filter((n) => typeof n === 'string' && n.trim() !== '')
        .map((n) => n.trim());
    }
    if (printers.default !== undefined) cfg.printers.default = String(printers.default);
    if (printers.allowRealPrinter !== undefined) {
      if (typeof printers.allowRealPrinter !== 'boolean') {
        throw new CliError(EXIT.ARGUMENT, 'config: printers.allowRealPrinter must be boolean');
      }
      cfg.printers.allowRealPrinter = printers.allowRealPrinter;
    }
    if (printers.realPrinters !== undefined) {
      if (!Array.isArray(printers.realPrinters)) {
        throw new CliError(EXIT.ARGUMENT, 'config: printers.realPrinters must be an array');
      }
      cfg.printers.realPrinters = printers.realPrinters
        .filter((n) => typeof n === 'string' && n.trim() !== '')
        .map((n) => n.trim());
    }
  }

  if (cfg.printers.allow.length === 0) {
    throw new CliError(EXIT.ARGUMENT, 'config: printers.allow cannot be empty');
  }
  if (!cfg.printers.allow.some((n) => n.toLowerCase() === cfg.printers.default.toLowerCase())) {
    throw new CliError(EXIT.ARGUMENT, 'config: printers.default must be in printers.allow');
  }

  const limits = raw.limits;
  if (limits !== undefined) {
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
      throw new CliError(EXIT.ARGUMENT, 'config: limits must be an object');
    }
    for (const key of ['maxCopiesWithoutForce', 'maxCopies']) {
      if (limits[key] !== undefined) {
        const n = Number(limits[key]);
        if (!Number.isInteger(n) || n < 1) {
          throw new CliError(EXIT.ARGUMENT, `config: limits.${key} must be a positive integer`);
        }
        cfg.limits[key] = n;
      }
    }
  }
  if (cfg.limits.maxCopiesWithoutForce > cfg.limits.maxCopies) {
    throw new CliError(EXIT.ARGUMENT, 'config: maxCopiesWithoutForce cannot exceed maxCopies');
  }

  if (raw.output?.dir !== undefined) {
    cfg.output.dir = raw.output.dir;
    safeRelativeDir(cfg.output.dir, 'output.dir');
  }
  if (raw.logging?.dir !== undefined) {
    cfg.logging.dir = raw.logging.dir;
    safeRelativeDir(cfg.logging.dir, 'logging.dir');
  }

  cfg.outputResolved = safeRelativeDir(cfg.output.dir, 'output.dir');
  cfg.loggingResolved = safeRelativeDir(cfg.logging.dir, 'logging.dir');
  cfg.path = CONFIG_PATH;
  cfg.loaded = fs.existsSync(CONFIG_PATH);
  return cfg;
}

export function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return normalizeConfig(clone(DEFAULT_CONFIG));
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    throw new CliError(EXIT.ARGUMENT, `config: cannot parse ${CONFIG_PATH}: ${error.message}`);
  }
  return normalizeConfig(raw);
}
