#!/usr/bin/env node
/**
 * printer-mcp：把「打印技能」暴露成 MCP 工具，任何支持 MCP 的 agent 都能一次调用完成打印。
 * 零依赖；stdio + 换行分隔 JSON-RPC 2.0。
 *
 * 工具：
 *   print_file  { path, printer?, copies?, paper?, quiet? }
 *   print_text  { text,  printer?, copies?, paper?, quiet? }
 *   print_url   { url,   printer?, copies?, paper?, quiet? }
 *   list_printers {}
 *   printer_status {}
 *
 * 环境变量：
 *   PRINTER_CMD   覆盖 CLI 入口（默认 <安装目录>\shim\printer.cmd 或同仓库 shim\printer.cmd）
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTOCOL_VERSION = '2024-11-05';

function resolveCli() {
  // 优先直接跑 .mjs（无 shell，无需转义，速度也快）
  const mjsCandidates = [
    join(HERE, '..', 'src', 'print-cli.mjs'),                                             // 仓库内
    join(process.env.USERPROFILE || '', '.ai-skills', 'printer', 'src', 'print-cli.mjs'),  // 已安装
    process.env.PRINTER_CLI || '',
  ];
  for (const c of mjsCandidates) if (c && existsSync(c)) return { kind: 'mjs', path: c };
  // 退回 shim（需要 shell）
  const cmdCandidates = [
    process.env.PRINTER_CMD || '',
    join(HERE, '..', 'shim', 'printer.cmd'),
    join(process.env.USERPROFILE || '', '.ai-skills', 'printer', 'shim', 'printer.cmd'),
  ];
  for (const c of cmdCandidates) if (c && existsSync(c)) return { kind: 'cmd', path: c };
  return { kind: 'cmd', path: 'printer' };
}

function runCli(cliArgs, timeoutMs = 180000) {
  const cli = resolveCli();
  const spawnArgs = cli.kind === 'mjs' ? [cli.path, ...cliArgs] : cliArgs;
  const file = cli.kind === 'mjs' ? process.execPath : cli.path;
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(file, spawnArgs, { windowsHide: true, shell: cli.kind === 'cmd' });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolvePromise({ ok: false, code: -1, out, err: String(e && e.message || e), ms: Date.now() - started }); });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ ok: code === 0, code, out: out.trim(), err: err.trim(), ms: Date.now() - started }); });
  });
}

function buildArgs(input, opts = {}) {
  const args = [];
  if (opts.quiet !== false) args.push('--quiet');
  if (opts.printer) args.push('--printer', String(opts.printer));
  if (opts.copies) args.push('--copies', String(opts.copies));
  if (opts.paper) args.push('--paper', String(opts.paper));
  // 自动缩字号把内容压进 N 页（"打在一张纸上"）
  if (opts.fit_pages) args.push('--fit-pages', String(opts.fit_pages));
  if (opts.force === true) args.push('--force');
  return args;
}

const TOOLS = [
  {
    name: 'print_file',
    description: '打印一个本地文件（.txt/.md/.png/.jpg/.jpeg/.pdf/.docx/.xlsx）。一次调用即完成，默认静默。printer 必须显式给出或依赖配置白名单，绝不使用系统默认打印机。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        printer: { type: 'string', description: '打印机名（可用 list_printers 查询）' },
        copies: { type: 'integer', minimum: 1, maximum: 5 },
        paper: { type: 'string', enum: ['A4', 'A5', 'Letter'] },
        fit_pages: { type: 'integer', minimum: 1, maximum: 50, description: '自动缩字号/行距把内容压进 N 页；用户说「打在一张纸上」就传 1' },
        force: { type: 'boolean', description: '60 秒内重复打印同一内容时强制重打' },
        quiet: { type: 'boolean', description: '默认 true；false 时返回完整 CLI 输出' },
      },
      required: ['path'],
    },
  },
  {
    name: 'print_text',
    description: '直接打印一段文本（无需先存文件）。适合「打印这段话」这类请求。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要打印的文本内容' },
        printer: { type: 'string' },
        copies: { type: 'integer', minimum: 1, maximum: 5 },
        paper: { type: 'string', enum: ['A4', 'A5', 'Letter'] },
        fit_pages: { type: 'integer', minimum: 1, maximum: 50, description: '自动缩字号/行距把内容压进 N 页；「打在一张纸上」传 1' },
        force: { type: 'boolean', description: '60 秒内重复打印同一内容时强制重打' },
        quiet: { type: 'boolean' },
      },
      required: ['text'],
    },
  },
  {
    name: 'print_url',
    description: '打印一个网页（http/https）。内部用 Edge 渲染成 PDF 再逐页转图打印，需要 Python 3 + pymupdf。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打印的网页地址' },
        printer: { type: 'string' },
        paper: { type: 'string', enum: ['A4', 'A5', 'Letter'] },
        quiet: { type: 'boolean' },
      },
      required: ['url'],
    },
  },
  {
    name: 'list_printers',
    description: '列出本机打印机及技能白名单。打印前如需确认目标，先调用它。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'printer_status',
    description: '查看技能运行状态：版本、配置路径、白名单、日志与输出目录。',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args) {
  if (name === 'list_printers') {
    const r = await runCli(['printers'], 60000);
    return { r };
  }
  if (name === 'printer_status') {
    const r = await runCli(['status'], 30000);
    return { r };
  }
  if (name === 'print_file') {
    if (!args || !args.path) throw new Error('path is required');
    const r = await runCli([String(args.path), ...buildArgs('file', args)]);
    return { r };
  }
  if (name === 'print_text') {
    if (!args || typeof args.text !== 'string' || !args.text.trim()) throw new Error('text is required');
    const r = await runCli(['text', String(args.text), ...buildArgs('text', args)]);
    return { r };
  }
  if (name === 'print_url') {
    if (!args || !/^https?:\/\//i.test(String(args.url))) throw new Error('url must start with http:// or https://');
    const r = await runCli(['url', String(args.url), ...buildArgs('url', args)]);
    return { r };
  }
  throw new Error('unknown tool: ' + name);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

let buffer = '';
let pending = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    try {
      if (msg.method === 'initialize') {
        reply(msg.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'printer-mcp', version: '1.3.1' },
        });
      } else if (msg.method === 'notifications/initialized' || msg.method === 'initialized') {
        // 无需回应
      } else if (msg.method === 'tools/list') {
        reply(msg.id, { tools: TOOLS });
      } else if (msg.method === 'tools/call') {
        const name = msg.params && msg.params.name;
        const args = (msg.params && msg.params.arguments) || {};
        pending++;
        try {
          const { r } = await callTool(name, args);
          const text = (r.out || r.err || (r.ok ? 'OK' : 'FAILED')).trim();
          reply(msg.id, { content: [{ type: 'text', text }], isError: !r.ok });
        } catch (e) {
          reply(msg.id, { content: [{ type: 'text', text: 'ERR: ' + (e && e.message || e) }], isError: true });
        } finally {
          pending--;
        }
      } else if (msg.method === 'ping') {
        reply(msg.id, {});
      } else if (msg.id !== undefined) {
        replyError(msg.id, -32601, 'method not found: ' + msg.method);
      }
    } catch (e) {
      if (msg.id !== undefined) replyError(msg.id, -32603, String(e && e.message || e));
    }
  }
});

process.stdin.on('end', async () => {
  // 等正在跑的工具调用结束再退出，避免管道输入结束时把任务掐掉
  const deadline = Date.now() + 170000;
  while (pending > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  process.exit(0);
});
