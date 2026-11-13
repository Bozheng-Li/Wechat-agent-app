import fs from 'node:fs';
import path from 'node:path';
import { ChannelError } from '../shared/contracts.mjs';

/** Resolve only ordinary paths under the selected data directory, including Windows junctions. */
export function workPath(root, relative = '.') {
  if (typeof relative !== 'string' || relative.length > 2000 || /[\u0000-\u001f\u007f]/.test(relative) || relative.includes(':') || path.isAbsolute(relative))
    throw new ChannelError('WORK_PATH_INVALID', '数据文件请使用数据目录内的相对路径');
  const file = path.resolve(root, relative), inside = path.relative(path.resolve(root), file);
  if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside))
    throw new ChannelError('WORK_PATH_INVALID', '数据文件超出数据目录');
  for (let current = file; ; current = path.dirname(current)) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (current !== file && !stat.isDirectory())) throw Error();
    } catch (error) {
      if (error.code !== 'ENOENT') throw new ChannelError('WORK_PATH_INVALID', '数据路径包含目录链接或无效目录');
    }
    if (path.dirname(current) === current) break;
  }
  return file;
}
