import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChannelError } from "../../shared/contracts.mjs";

// A freshly created lock file is empty for a moment before its JSON body lands.
// Readers must not mistake that window for another data instance, so parsing is
// retried briefly; `undefined` means "cannot tell", never "different owner".
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function owner(file, attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
    }
    if (attempt + 1 < attempts) pause(2);
  }
  return undefined;
}
function unlinkQuietly(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function archiveLock(directory, ownerStoreId, key) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink() || fs.lstatSync(path.dirname(directory)).isSymbolicLink())
    throw new ChannelError('CONVERSATION_PATH_CONFLICT', '会话目录包含重定向链接，未向其他目录写入数据');
  const file = path.join(directory, '.wechat-agent-write.lock'),
    token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try {
      handle = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(handle, JSON.stringify({ ownerStoreId, key, pid: process.pid, token }));
      fs.closeSync(handle);
      handle = undefined;
      return () => {
        let holder;
        try {
          holder = owner(file, 1);
        } catch (error) {
          throw new ChannelError('STATE_WRITE_FAILED', '会话文件已写入但目录锁无法释放，请检查权限后重新启动应用');
        }
        // An unreadable lock cannot prove foreign ownership: it is a half-written
        // or corrupt artifact, and keeping it would wedge this directory forever.
        if (holder === undefined || holder.token === token) {
          try {
            unlinkQuietly(file);
          } catch (error) {
            throw new ChannelError('STATE_WRITE_FAILED', '会话文件已写入但目录锁无法释放，请检查权限后重新启动应用');
          }
        }
      };
    } catch (error) {
      if (handle !== undefined) {
        try {
          fs.closeSync(handle);
        } catch {}
        try {
          unlinkQuietly(file);
        } catch {}
      }
      if (error.code !== 'EEXIST') throw error;
      const holder = owner(file);
      if (!holder)
        throw new ChannelError('STATE_WRITE_FAILED', '会话目录锁文件无法读取，另一个实例可能正在写入；请稍后重试');
      if (holder.ownerStoreId !== ownerStoreId || holder.key !== key)
        throw new ChannelError('CONVERSATION_PATH_CONFLICT', '目标会话目录由其他数据实例使用，未覆盖已有记录');
      if (alive(holder.pid))
        throw new ChannelError(
          'STATE_WRITE_FAILED',
          '会话目录正由另一个实例写入，自动回复已暂停；请只保留一个使用该目录的实例'
        );
      // Reap only a dead writer belonging to this exact store and conversation.
      try {
        unlinkQuietly(file);
      } catch {
        throw new ChannelError('STATE_WRITE_FAILED', '会话目录锁无法清除，请检查权限后重新启动应用');
      }
    }
  }
  throw new ChannelError('STATE_WRITE_FAILED', '会话目录正在被占用，未继续处理消息');
}

export function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

export function acquireLock(root) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'owner.lock');
  const token = randomUUID();
  const write = (workerPid) =>
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, workerPid, token }), { mode: 0o600 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      fs.closeSync(fd);
      return {
        worker(pid) {
          write(pid);
        },
        release() {
          let holder;
          try {
            holder = owner(file, 1);
          } catch {
            return;
          }
          if (holder !== undefined && holder.token !== token) return;
          try {
            unlinkQuietly(file);
          } catch {}
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = owner(file);
      if (!holder) throw new ChannelError('OWNER_BUSY', '微信助手的实例锁尚未释放，请稍后重新启动应用');
      if (alive(holder.pid) || alive(holder.workerPid))
        throw new ChannelError('OWNER_BUSY', '另一个应用实例正在使用此数据目录；请先退出该实例');
      try {
        unlinkQuietly(file);
      } catch {
        throw new ChannelError('OWNER_BUSY', '微信助手正在重载，请稍后重试');
      }
    }
  }
  throw new ChannelError('OWNER_BUSY', '微信助手正在重载，请稍后重试');
}
