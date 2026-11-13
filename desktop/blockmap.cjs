'use strict';
// electron-builder publishes a .blockmap next to every installer. It is a
// gzipped JSON document listing one truncated digest per fixed-size block, so
// the same bytes always produce the same string in every version. This module
// only ever compares those strings: the digest algorithm is never recomputed.
const zlib = require('node:zlib');

const MAX_TOTAL = 1024 * 1024 * 1024;
const MAX_UNPACKED = 32 * 1024 * 1024;
const CHECKSUM = /^[A-Za-z0-9+/=_-]{16,64}$/;

class BlockmapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BlockmapError';
    this.code = code;
  }
}

function invalid(message) {
  return new BlockmapError('BLOCKMAP_INVALID', message);
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}

// Returns { version, name, checksums, sizes } or throws BlockmapError.
// Anything that is not an unambiguous single-file layout is rejected: the
// caller then downloads the whole installer instead of guessing.
function parseBlockmap(buffer) {
  const raw = asBuffer(buffer);
  if (!raw || !raw.length) throw invalid('blockmap 内容为空');
  let text;
  if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      text = zlib.gunzipSync(raw, { maxOutputLength: MAX_UNPACKED }).toString('utf8');
    } catch {
      throw invalid('blockmap 解压失败');
    }
  } else {
    text = raw.toString('utf8');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw invalid('blockmap 不是有效的 JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid('blockmap 结构无效');
  if (data.version !== 2) throw invalid('blockmap 版本不受支持');
  if (!Array.isArray(data.files) || data.files.length !== 1) throw invalid('blockmap 必须只描述一个文件');
  const file = data.files[0];
  if (!file || typeof file !== 'object') throw invalid('blockmap 文件描述无效');
  const { checksums, sizes } = file;
  if (!Array.isArray(checksums) || !checksums.length) throw invalid('blockmap 缺少分块校验和');
  if (!Array.isArray(sizes) || !sizes.length) throw invalid('blockmap 缺少分块大小');
  if (checksums.length !== sizes.length) throw invalid('blockmap 分块数量不一致');
  let total = 0;
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size <= 0) throw invalid('blockmap 分块大小无效');
    total += size;
    if (total > MAX_TOTAL) throw invalid('blockmap 描述的文件过大');
  }
  for (const checksum of checksums) {
    if (typeof checksum !== 'string' || !CHECKSUM.test(checksum)) throw invalid('blockmap 分块校验和无效');
  }
  return {
    version: 2,
    name: typeof file.name === 'string' ? file.name : '',
    checksums: checksums.slice(),
    sizes: sizes.slice(),
  };
}

// Cumulative offsets keep the planner independent of any positions the file
// header may claim, so a rewritten blockmap can never point outside its file.
function blockLayout(map) {
  if (!map || !Array.isArray(map.sizes) || !Array.isArray(map.checksums) || map.sizes.length !== map.checksums.length)
    throw invalid('blockmap 布局不可用');
  const offsets = [], sizes = [], checksums = [];
  let offset = 0;
  for (let index = 0; index < map.sizes.length; index += 1) {
    const size = map.sizes[index], checksum = map.checksums[index];
    if (!Number.isSafeInteger(size) || size <= 0) throw invalid('blockmap 分块大小无效');
    if (typeof checksum !== 'string' || !checksum) throw invalid('blockmap 分块校验和无效');
    if (offset + size > MAX_TOTAL) throw invalid('blockmap 描述的文件过大');
    offsets.push(offset); sizes.push(size); checksums.push(checksum);
    offset += size;
  }
  return { offsets, sizes, checksums, size: offset };
}

// Maps every reusable new block onto its old offset and coalesces the remaining
// gaps into range requests. Rejects a plan that would not actually save bytes.
function planDelta(oldLayout, newLayout) {
  if (!oldLayout || !newLayout || !newLayout.sizes || !newLayout.checksums)
    throw invalid('增量计划缺少布局');
  const newSize = Number.isSafeInteger(newLayout.size) && newLayout.size > 0
    ? newLayout.size
    : (newLayout.sizes || []).reduce((sum, size) => sum + size, 0);
  if (!newSize) throw new BlockmapError('DELTA_NO_GAIN', '增量计划没有可用分块');
  const oldSize = Number.isSafeInteger(oldLayout.size) ? oldLayout.size : 0;
  const known = new Map();
  for (let index = 0; index < oldLayout.checksums.length; index += 1) {
    const checksum = oldLayout.checksums[index];
    if (typeof checksum !== 'string' || !checksum) continue;
    if (known.has(checksum)) continue; // duplicates keep the first (lowest) offset
    known.set(checksum, oldLayout.offsets[index]);
  }
  const copy = [], fetch = [];
  let reusedBytes = 0, fetchBytes = 0, open = null;
  for (let index = 0; index < newLayout.sizes.length; index += 1) {
    const offset = newLayout.offsets[index], size = newLayout.sizes[index];
    const from = known.get(newLayout.checksums[index]);
    if (Number.isSafeInteger(from) && from >= 0 && from + size <= oldSize) {
      copy.push({ from, to: offset, size });
      reusedBytes += size;
      if (open) { fetch.push(open); open = null; }
      continue;
    }
    fetchBytes += size;
    if (open && open.end === offset) {
      open.end = offset + size;
      open.size += size;
    } else {
      if (open) fetch.push(open);
      open = { start: offset, end: offset + size, size };
    }
  }
  if (open) fetch.push(open);
  if (!reusedBytes || fetchBytes >= newSize)
    throw new BlockmapError('DELTA_NO_GAIN', '增量计划没有收益');
  return { copy, fetch, reusedBytes, fetchBytes };
}

module.exports = {
  BlockmapError, MAX_TOTAL, parseBlockmap, blockLayout, planDelta,
};
