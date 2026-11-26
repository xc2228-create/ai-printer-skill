import fs from 'node:fs';
import { CliError, EXIT } from './errors.mjs';
import { RENDER_SCRIPT, runPythonScript } from './py.mjs';
import { pdfToPngs } from './urlrender.mjs';

// PDF 输入 = 逐页 200dpi 位图 → 走图片打印（与 URL 链路同一条渲染实现）。
// 页数在渲染前先数出来：60 页的文档不该先跑 2 分钟再被拒绝。

export const MAX_DOC_PAGES = 50;
export const PDF_DPI = 200;

export function readPdfInfo(pdfPath, options = {}) {
  if (!fs.existsSync(RENDER_SCRIPT)) {
    throw new CliError(EXIT.RENDER, '缺少 PDF 渲染脚本: ' + RENDER_SCRIPT);
  }
  const result = runPythonScript(RENDER_SCRIPT, [pdfPath, '--count'], {
    timeoutMs: options.timeoutMs || 60000,
    label: 'PDF 页数读取',
  });
  const pages = Number(result.parsed.pages || 0);
  if (!pages) {
    throw new CliError(EXIT.RENDER, 'PDF 没有可用页面: ' + pdfPath);
  }
  const width = Number(result.parsed.width || 0);
  const height = Number(result.parsed.height || 0);
  const landscapePages = Number(result.parsed.landscapePages || 0);
  return {
    pages,
    width,
    height,
    // 多页混合方向时按多数页决定纸张方向；少数页会被等比缩到纸内（已知限制）
    landscape: landscapePages > pages / 2,
    landscapePages,
  };
}

export function assertPageLimit(pages, force, what) {
  if (pages > MAX_DOC_PAGES && !force) {
    throw new CliError(
      EXIT.ARGUMENT,
      what + '共 ' + pages + ' 页，超过 ' + MAX_DOC_PAGES + ' 页安全上限（确认要打请加 --force）',
    );
  }
}

export function renderPdfPages(pdfPath, workDir) {
  const rendered = pdfToPngs(pdfPath, workDir, { dpi: PDF_DPI });
  return {
    pages: rendered.pages,
    pngs: rendered.pngs,
    dpi: rendered.dpi,
    screenshotPdfPages: rendered.screenshotPdfPages,
  };
}
