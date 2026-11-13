import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ChannelError } from '../../shared/contracts.mjs';
import { WORK_ARTIFACT_LIMITS, artifactName, artifactMetadata } from '../../shared/work-artifacts.mjs';
import { inspectAssetImage } from './image-format.mjs';
import { workPath } from '../paths.mjs';

const formats = { '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.pdf': 'application/pdf', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.zip': 'application/zip', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

/** List ordinary files below a data directory; internal bookkeeping is never exposed. */
export function directoryFiles(cwd) {
  const files = [];
  const visit = (directory, depth) => {
    if (depth > 8 || files.length >= 100) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ['.wechat-work', '.wechat-inputs', '.git', 'node_modules', '.venv'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file, depth + 1);
      else if (entry.isFile() && files.length < 100) files.push({ path: path.relative(cwd, file).replaceAll('\\', '/'), bytes: fs.statSync(file).size });
    }
  };
  visit(cwd, 0); return files;
}

/** Read a registered image or file with its digest so callers can prove the bytes did not change. */
export function readWorkArtifact(cwd, relative, expected, sendAs = expected?.kind ?? 'auto') {
  const target = workPath(cwd, relative), normalized = path.relative(cwd, target).replaceAll('\\', '/');
  if (normalized.split('/').some(part => part.toLowerCase() === '.wechat-work')) throw new ChannelError('WORK_ARTIFACT_INVALID', '内部记录不能作为媒体回传');
  const name = artifactName(path.basename(target)), extension = path.extname(name).toLowerCase();
  if (!['auto', 'file', 'image'].includes(sendAs)) throw new ChannelError('WORK_ARTIFACT_INVALID', '请选择自动、文件附件或图片回传方式');
  let bytes;
  try {
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size < 1 || !Number.isSafeInteger(stat.size)) throw new ChannelError('WORK_ARTIFACT_SIZE', '媒体文件为空或不是有效的普通文件');
      bytes = fs.readFileSync(descriptor);
      if (bytes.length !== stat.size) throw new ChannelError('WORK_ARTIFACT_CHANGED', '媒体文件正在变化，请保存完成后重新登记');
    } finally { fs.closeSync(descriptor); }
    workPath(cwd, normalized);
  } catch (error) {
    if (error instanceof ChannelError) throw error;
    throw new ChannelError('WORK_ARTIFACT_UNAVAILABLE', '媒体文件无法读取，请检查文件是否已生成并保留在数据目录');
  }
  let kind = 'file', mediaType = formats[extension] || 'application/octet-stream';
  if (sendAs === 'image' || sendAs === 'auto' && /^\.(?:png|jpe?g)$/.test(extension)) {
    const info = inspectAssetImage(bytes, { maxBytes: bytes.length });
    if (!['image/png', 'image/jpeg'].includes(info.mediaType) || !/^\.(?:png|jpe?g)$/.test(extension) || info.mediaType !== (extension === '.png' ? 'image/png' : 'image/jpeg'))
      throw new ChannelError('WORK_ARTIFACT_INVALID', '图片格式与扩展名不一致');
    kind = bytes.length > WORK_ARTIFACT_LIMITS.imageBytes ? 'file' : 'image'; mediaType = info.mediaType;
  }
  const metadata = { path: normalized, name, kind, bytes: bytes.length, mediaType, sha256: createHash('sha256').update(bytes).digest('hex') };
  if (expected && (!artifactMetadata(expected) || Object.keys(metadata).some(key => metadata[key] !== expected[key])))
    throw new ChannelError('WORK_ARTIFACT_CHANGED', '媒体文件在登记后已变化，旧内容尚未回传；请核对后重新登记');
  return { metadata, segment: { type: kind, data: { name, mediaType, base64: bytes.toString('base64') } } };
}
