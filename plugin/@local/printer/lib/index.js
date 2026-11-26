/**
 * @local/printer - host half of the AI printer skill.
 *
 * Deliberately imports NOTHING from @deepseek-ai/*: a plugin that lives in
 * <dsh-home>/profiles/node_modules/@local/printer cannot resolve the harness
 * packages (they only exist inside the dsh install's own node_modules), so the
 * tool definition is built as the plain object that ctx.tools.register() accepts
 * (see @deepseek-ai/dsh-tools: register() reads name/description/parameters/
 * output{ schema, render }/execute from the definition it is handed).
 *
 * Verified contract: output.schema must be a supported JSON Schema with an
 * object root, parameters are raw JSON Schema, and execute() must return exactly
 * the declared value.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

const name = 'printer';
const inject = ['tools'];

const MAX_STDOUT = 4 * 1024 * 1024;

function resolveCli(config) {
  const configured = config && typeof config.cliPath === 'string' ? config.cliPath.trim() : '';
  if (configured) return configured;
  const fromEnv = (process.env.AI_PRINTER_CLI || '').trim();
  if (fromEnv) return fromEnv;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return path.join(home, '.ai-skills', 'printer', 'src', 'print-cli.mjs');
}

/**
 * Run the CLI and resolve with its raw result. Rejects only on spawn failure,
 * timeout or abort; a non-zero CLI exit is a normal result the caller inspects.
 */
function runCli(cliPath, args, options) {
  const timeoutMs = options.timeoutMs || 120000;
  const signal = options.signal;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, [cliPath, ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new Error('cannot start node: ' + error.message));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(reject, new Error('print-cli timed out after ' + timeoutMs + ' ms'));
    }, timeoutMs);
    const onAbort = () => {
      try { child.kill(); } catch {}
      finish(reject, new Error('print-cli aborted'));
    };
    if (signal) {
      if (signal.aborted) {
        try { child.kill(); } catch {}
        finish(reject, new Error('print-cli aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_STDOUT) {
        try { child.kill(); } catch {}
        finish(reject, new Error('print-cli produced more than ' + MAX_STDOUT + ' bytes on stdout'));
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish(reject, new Error('cannot start print-cli: ' + error.message)));
    child.on('close', (code) => finish(resolve, { code: code === null ? -1 : code, stdout, stderr }));
  });
}

function parseEnvelope(stdout, stderr, code) {
  const text = String(stdout || '').replace(/^\uFEFF/, '').trim();
  const line = text.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
  if (!line) {
    throw new Error('print-cli returned no JSON envelope (exit ' + code + ')' + (stderr ? ': ' + stderr.trim().slice(0, 800) : ''));
  }
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error('print-cli returned invalid JSON: ' + error.message);
  }
}

async function call(cliPath, args, options) {
  const result = await runCli(cliPath, args, options);
  const envelope = parseEnvelope(result.stdout, result.stderr, result.code);
  if (result.code !== 0 || !envelope.ok) {
    const error = envelope.error || {};
    const code = error.code !== undefined ? error.code : result.code;
    const message = error.message || result.stderr.trim() || 'print-cli failed';
    const failure = new Error('print-cli failed [exit ' + code + ']: ' + message);
    failure.exitCode = code;
    throw failure;
  }
  return envelope;
}

const PRINTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'status', 'type', 'driver', 'default', 'real', 'whitelisted'],
  properties: {
    name: { type: 'string', description: 'Windows printer name, pass it verbatim to printer_print.printer' },
    status: { type: 'string' },
    type: { type: 'string' },
    driver: { type: 'string' },
    default: { type: 'boolean', description: 'Windows default printer; read-only, never used implicitly' },
    real: { type: 'boolean', description: 'true means physical paper output' },
    whitelisted: { type: 'boolean', description: 'false means printer_print will refuse this printer' },
  },
};

const printerListOutput = {
  type: 'object',
  additionalProperties: false,
  required: ['printers', 'defaultPrinter', 'whitelist', 'allowRealPrinter'],
  properties: {
    printers: { type: 'array', items: PRINTER_SCHEMA },
    defaultPrinter: { type: 'string', description: 'Windows default printer, empty when unknown' },
    whitelist: { type: 'array', items: { type: 'string' } },
    allowRealPrinter: { type: 'boolean' },
  },
};

const printerStatusOutput = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'node', 'platform', 'projectRoot', 'configPath', 'configLoaded', 'defaultPrinter', 'allowRealPrinter', 'whitelist', 'logDir', 'outputDir', 'supportedFormats', 'blockedExtensions'],
  properties: {
    version: { type: 'string' },
    node: { type: 'string' },
    platform: { type: 'string' },
    projectRoot: { type: 'string' },
    configPath: { type: 'string' },
    configLoaded: { type: 'boolean' },
    defaultPrinter: { type: 'string' },
    allowRealPrinter: { type: 'boolean' },
    whitelist: { type: 'array', items: { type: 'string' } },
    logDir: { type: 'string' },
    outputDir: { type: 'string' },
    supportedFormats: { type: 'array', items: { type: 'string' } },
    blockedExtensions: { type: 'array', items: { type: 'string' } },
  },
};

const printerPrintOutput = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'exitCode', 'file', 'printer', 'copies', 'paper', 'landscape', 'dryRun', 'pages', 'outputPdf', 'bytes', 'elapsedMs', 'message'],
  properties: {
    ok: { type: 'boolean' },
    exitCode: { type: 'integer' },
    file: { type: 'string' },
    printer: { type: 'string' },
    copies: { type: 'integer' },
    paper: { type: 'string' },
    landscape: { type: 'boolean' },
    dryRun: { type: 'boolean' },
    pages: { type: 'integer' },
    outputPdf: { type: 'string', description: 'created PDF path, empty for a physical printer or a dry run' },
    bytes: { type: 'integer' },
    elapsedMs: { type: 'integer' },
    message: { type: 'string' },
  },
};

function str(value) {
  return value === null || value === undefined ? '' : String(value);
}

function apply(ctx, config) {
  const cliPath = resolveCli(config);

  ctx.tools.register({
    name: 'printer_list',
    description:
      'List the Windows printers installed on this machine together with the skill whitelist. Always call this first: printer_print requires an explicit --printer name, and never assumes the Windows default printer.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: printerListOutput,
      render: (_args, value) => [{
        type: 'text',
        text: value.printers.map((p) => [
          p.name,
          p.default ? '(default)' : '',
          '[' + p.status + ']',
          p.whitelisted ? 'allowed' : 'BLOCKED',
          p.real ? 'physical' : 'virtual',
        ].filter(Boolean).join(' ')).join('\n') + '\nwhitelist: ' + value.whitelist.join(' | '),
      }],
    },
    async execute(_args, exec) {
      const envelope = await call(cliPath, ['printers', '--json'], { timeoutMs: 60000, signal: exec && exec.signal });
      const data = envelope.data || {};
      return {
        printers: (data.printers || []).map((p) => ({
          name: str(p.name),
          status: str(p.status),
          type: str(p.type),
          driver: str(p.driver),
          default: Boolean(p.default),
          real: Boolean(p.real),
          whitelisted: Boolean(p.whitelisted),
        })),
        defaultPrinter: str(data.defaultPrinter),
        whitelist: (data.whitelist || []).map(str),
        allowRealPrinter: Boolean(data.allowRealPrinter),
      };
    },
  });

  ctx.tools.register({
    name: 'printer_status',
    description:
      'Read the printer skill runtime status: CLI version, config path, whitelist, log and output directories, supported and blocked file types. Use it to diagnose exit codes 3 and 6 before retrying a print.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: printerStatusOutput,
      render: (_args, value) => [{
        type: 'text',
        text: [
          'print-cli ' + value.version + ' on node ' + value.node + ' (' + value.platform + ')',
          'project: ' + value.projectRoot,
          'config: ' + value.configPath + (value.configLoaded ? ' (loaded)' : ' (built-in defaults)'),
          'whitelist: ' + value.whitelist.join(' | '),
          'output: ' + value.outputDir,
        ].join('\n'),
      }],
    },
    async execute(_args, exec) {
      const envelope = await call(cliPath, ['status', '--json'], { timeoutMs: 60000, signal: exec && exec.signal });
      const d = envelope.data || {};
      return {
        version: str(d.version),
        node: str(d.node),
        platform: str(d.platform),
        projectRoot: str(d.projectRoot),
        configPath: str(d.configPath),
        configLoaded: Boolean(d.configLoaded),
        defaultPrinter: str(d.defaultPrinter),
        allowRealPrinter: Boolean(d.allowRealPrinter),
        whitelist: (d.whitelist || []).map(str),
        logDir: str(d.logDir),
        outputDir: str(d.outputDir),
        supportedFormats: (d.supportedFormats || []).map(str),
        blockedExtensions: (d.blockedExtensions || []).map(str),
      };
    },
  });

  ctx.tools.register({
    name: 'printer_print',
    description:
      'Print a .txt/.md/.png/.jpg/.jpeg/.pdf/.docx/.xlsx file on Windows. The printer argument is mandatory and must match a name returned by printer_list: never guess, never rely on the Windows default. Use dryRun:true first for anything the user has not explicitly confirmed, and only send work to a physical printer after the user asked for paper output. Executables (.exe/.bat/.cmd/.ps1) are refused with exit 6. Copies above 5 are refused without --force (this tool never sends --force).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['file', 'printer'],
      properties: {
        file: { type: 'string', description: 'Path to the .txt/.md/.png/.jpg/.jpeg/.pdf/.docx/.xlsx file to print. Relative paths resolve against the session working directory.' },
        printer: { type: 'string', description: 'Exact printer name from printer_list, e.g. "Microsoft Print to PDF". Required.' },
        copies: { type: 'integer', description: 'Number of copies, 1-5. Default 1.' },
        paper: { type: 'string', enum: ['A4', 'A5', 'Letter'], description: 'Paper size. Default A4.' },
        landscape: { type: 'boolean', description: 'Print in landscape orientation.' },
        dryRun: { type: 'boolean', description: 'Validate everything without submitting a print job or writing a PDF. Recommended before the first real print.' },
        force: { type: 'boolean', description: 'Allow reprinting identical content inside the 60s dedupe window.' },
        fitPages: { type: 'integer', minimum: 1, maximum: 50, description: 'Auto-shrink font/spacing so the content fits in N pages (user says "one A4 page" -> 1).' },
        quiet: { type: 'boolean', description: 'Return the one-line result only (default true).' },
      },
    },
    output: {
      schema: printerPrintOutput,
      render: (_args, value) => [{
        type: 'text',
        text: value.message,
      }],
    },
    async execute(args, exec) {
      const printer = str(args.printer).trim();
      if (!printer) throw new Error('printer is required and must not be empty: call printer_list and pass an exact name');
      const cliArgs = ['print', args.file, '--printer', printer, '--json'];
      if (args.copies !== undefined) cliArgs.push('--copies', String(args.copies));
      if (args.paper !== undefined) cliArgs.push('--paper', String(args.paper));
      if (args.landscape === true) cliArgs.push('--landscape');
      if (args.dryRun === true) cliArgs.push('--dry-run');
      if (args.force === true) cliArgs.push('--force');
      if (args.fitPages !== undefined) cliArgs.push('--fit-pages', String(args.fitPages));
      if (args.quiet === true) cliArgs.push('--quiet');
      const envelope = await call(cliPath, cliArgs, { timeoutMs: 180000, signal: exec && exec.signal });
      const d = envelope.data || {};
      const dryRun = Boolean(d.dryRun);
      return {
        ok: true,
        exitCode: 0,
        file: str(d.file),
        printer: str(d.printer),
        copies: Number(d.copies || 1),
        paper: str(d.paper || 'A4'),
        landscape: Boolean(d.landscape),
        dryRun,
        pages: Number(d.pages || 0),
        outputPdf: str(d.outputPdf),
        bytes: Number(d.bytes || 0),
        elapsedMs: Number(envelope.durationMs || 0),
        message: dryRun
          ? 'DRY-RUN OK: ' + str(d.file) + ' -> ' + str(d.printer) + ' (no print job submitted)'
          : 'printed ' + str(d.file) + ' -> ' + str(d.printer) + ' (' + Number(d.pages || 0) + ' page(s), ' + Number(d.copies || 1) + ' copies)',
      };
    },
  });

  // 直接打印一段文本：用户说「打印这句话」时一次调用完成，不用先存文件
  ctx.tools.register({
    name: 'printer_text',
    description:
      'Print a piece of text directly on a Windows printer, without writing a file first. Use this when the user says "print this text/paragraph" or pastes content to be printed. The printer argument is mandatory: call printer_list first and pass an exact name, never the Windows default.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'printer'],
      properties: {
        text: { type: 'string', description: 'Text content to print (UTF-8). Multi-line is fine.' },
        printer: { type: 'string', description: 'Exact printer name from printer_list.' },
        copies: { type: 'integer', description: 'Number of copies, 1-5. Default 1.' },
        paper: { type: 'string', enum: ['A4', 'A5', 'Letter'], description: 'Paper size. Default A4.' },
        fitPages: { type: 'integer', minimum: 1, maximum: 50, description: 'Auto-shrink font/spacing to fit N pages (user says "one A4 page" -> 1).' },
        quiet: { type: 'boolean', description: 'Return the one-line result only (default true).' },
      },
    },
    output: {
      schema: printerPrintOutput,
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const printer = str(args.printer).trim();
      if (!printer) throw new Error('printer is required: call printer_list and pass an exact name');
      const text = str(args.text);
      if (!text.trim()) throw new Error('text is required and must not be empty');
      const cliArgs = ['text', text, '--printer', printer, '--json', '--quiet'];
      if (args.copies !== undefined) cliArgs.push('--copies', String(args.copies));
      if (args.fitPages !== undefined) cliArgs.push('--fit-pages', String(args.fitPages));
      if (args.paper !== undefined) cliArgs.push('--paper', String(args.paper));
      const envelope = await call(cliPath, cliArgs, { timeoutMs: 180000, signal: exec && exec.signal });
      const d = envelope.data || {};
      return {
        ok: true,
        exitCode: 0,
        file: '(text)',
        printer: str(d.printer || printer),
        copies: Number(d.copies || 1),
        paper: str(d.paper || 'A4'),
        landscape: false,
        dryRun: false,
        pages: Number(d.pages || 0),
        outputPdf: str(d.outputPdf),
        bytes: Number(d.bytes || 0),
        elapsedMs: Number(envelope.durationMs || 0),
        message: str(d.resultLine || ('printed text -> ' + printer)),
      };
    },
  });
}

export { name, apply, inject, resolveCli };
