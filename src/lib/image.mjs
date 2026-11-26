import fs from 'node:fs';
import path from 'node:path';
import { CliError, EXIT } from './errors.mjs';

export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 120 * 1000 * 1000;
export const MAX_IMAGE_SIDE = 30000;

function parsePng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) return null;
  return { format: 'PNG', width, height };
}

function parseJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 1 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    offset += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (sof.has(marker) && length >= 7) {
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (!width || !height) return null;
      return { format: 'JPEG', width, height };
    }
    offset += length;
  }
  return null;
}

export function readImageInfo(file) {
  const ext = path.extname(file).toLowerCase();
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    throw new CliError(EXIT.ARGUMENT, 'cannot read image file: ' + error.message);
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new CliError(EXIT.ARGUMENT, 'image is larger than 50 MiB: ' + file);
  }
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch (error) {
    throw new CliError(EXIT.ARGUMENT, 'cannot read image file: ' + error.message);
  }
  const isPngExt = ext === '.png';
  const isJpegExt = ext === '.jpg' || ext === '.jpeg';
  const info = isPngExt ? parsePng(buffer) : isJpegExt ? parseJpeg(buffer) : null;
  if (!info) {
    throw new CliError(EXIT.RENDER, 'image content does not match its extension or is corrupt: ' + file);
  }
  if (info.width > MAX_IMAGE_SIDE || info.height > MAX_IMAGE_SIDE) {
    throw new CliError(EXIT.RENDER, 'image dimensions exceed 30000 px: ' + info.width + 'x' + info.height);
  }
  if (info.width * info.height > MAX_IMAGE_PIXELS) {
    throw new CliError(EXIT.RENDER, 'image exceeds 120 megapixels: ' + info.width + 'x' + info.height);
  }
  return {
    ...info,
    bytes: stat.size,
    extension: ext,
  };
}
