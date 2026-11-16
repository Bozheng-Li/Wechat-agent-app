import { resourcePath } from "../platform/resources.mjs";
import path from 'node:path';

import { CHANNEL, ChannelError, publicError } from "../../shared/contracts.mjs";
import { acquireLock } from "../storage/locks.mjs";
import { sameDirectory } from "../storage/paths.mjs";
import { WechatRuntime } from "./runtime.mjs";
import { readWorkspaceLocation, describeWorkspace, migrateWorkspaceRoot } from "../storage/workspace.mjs";
import { rpcHandler } from "../rpc/handler.mjs";
import { createPluginService } from "./service.mjs";

// A macrotask hop: lets Electron paint the startup progress before a slow
// synchronous store open takes over the main process.
const breathe = () => new Promise(resolve => setImmediate(resolve));

export async function startApplication(ctx, { progress, lazy = false } = {}) {
  const bootstrap = path.resolve(ctx.dataHome);
  let resolvedRoot = bootstrap;
  const resources = resourcePath();
  let lock,
    current,
    service,
    startupError,
    disposed = false,
    closing;
  const runtimes = new Set();
  const lifetime = new AbortController();
  const close = () =>
    (closing ??= (async () => {
      disposed = true;
      lifetime.abort();
      try {
        await Promise.allSettled([...runtimes].map((runtime) => runtime.close()));
        await service?.drain();
        await Promise.allSettled([...runtimes].map((runtime) => runtime.close()));
      } finally {
        lock?.release();
      }
    })());
  // Cordis runs sibling disposers concurrently. This one owns the complete
  // drain -> child exit -> exclusive-lock release sequence.
  const open = async (root) => {
    lifetime.signal.throwIfAborted();
    const runtime = new WechatRuntime({ ctx, root, bootstrap, resources, ownerLock: lock, signal: lifetime.signal });
    runtimes.add(runtime);
    try {
      await runtime.ready();
      return runtime;
    } catch (error) {
      try {
        await runtime.close();
      } finally {
        runtimes.delete(runtime);
      }
      throw error;
    }
  };
  const relocateWorkspace = async (target, signal) => {
    signal?.throwIfAborted();
    lifetime.signal.throwIfAborted();
    const previous = current;
    if (sameDirectory(previous.root, target) && !describeWorkspace(previous.root, previous.store).legacyPaths.length)
      return;
    let transfer, next;
    try {
      await previous.stop();
      signal?.throwIfAborted();
      lifetime.signal.throwIfAborted();
      transfer = migrateWorkspaceRoot({ bootstrap, store: previous.store, targetRoot: target });
      next = await open(transfer.root);
      signal?.throwIfAborted();
      lifetime.signal.throwIfAborted();
      transfer.commit();
      transfer = undefined;
    } catch (error) {
      try {
        await next?.close();
      } catch {
        /* Worker close is still awaited in its finally. */
      }
      if (next) runtimes.delete(next);
      try {
        transfer?.rollback();
        previous.releaseLock();
        runtimes.delete(previous);
        if (!disposed) {
          current = await open(previous.root);
          service.replaceRuntime(current);
          await current.activate();
        }
      } catch (recoveryError) {
        service.setStartupError(recoveryError);
        throw new ChannelError(
          'WORKSPACE_RECOVERY_FAILED',
          '目录切换未完成，原数据和已复制的数据均保留；恢复连接失败，请检查目录后重新启动应用'
        );
      }
      throw error;
    }
    current = next;
    service.replaceRuntime(next);
    try {
      previous.releaseLock();
      runtimes.delete(previous);
    } catch {
      next.scheduler.error = '新目录已生效，旧目录锁暂未能清理；请保留旧目录并检查文件占用';
    }
    // No new message is admitted to the network until the pointer and all
    // root-bound services agree on the committed destination.
    await current.activate();
  };
  // Desktop startup is lazy: the window opens as soon as the data directory is
  // claimed, and requests wait here for the stores and the WeChat runtime instead of
  // holding the whole UI back. Tests keep the eager path.
  const initialize = async () => {
    try {
      progress?.('lock');
      // The window is already on screen and painting this stage; yielding between
      // stages keeps the main process answering Windows instead of "未响应".
      await breathe();
      lock = acquireLock(bootstrap);
      resolvedRoot = readWorkspaceLocation(bootstrap);
      progress?.('open');
      await breathe();
      current = await open(resolvedRoot);
    } catch (error) {
      startupError = publicError(error, '微信助手启动失败，请检查安装包或重新启动应用');
      try {
        await current?.close();
      } finally {
        lock?.release();
        lock = undefined;
      }
    }
    progress?.('service');
    await breathe();
    service = createPluginService({
      ctx,
      root: current?.root || resolvedRoot,
      ...current,
      relocateWorkspace,
      startupError,
      isDisposed: () => disposed,
      lifetime: lifetime.signal,
    });
    const dispatch = rpcHandler(service, () => disposed);
    if (startupError || !current) return dispatch;
    // Connecting to WeChat takes the longest and settings do not need it, so a lazy
    // start returns the dispatcher first and only eager callers wait for activation.
    progress?.('activate');
    const activation = (async () => {
      try {
        await current.activate();
      } catch (error) {
        if (lazy) { service.setStartupError?.(error); return; }
        startupError = publicError(error, '微信助手启动失败，请检查安装包或重新启动应用');
        try {
          await current?.close();
        } finally {
          lock?.release();
          lock = undefined;
        }
      }
    })();
    if (!lazy) await activation;
    else void activation;
    return dispatch;
  };
  const started = initialize();
  const handle = {
    call: async (endpoint, payload = {}, signal = new AbortController().signal) =>
      (await started)(endpoint, payload, signal, { principal: { kind: 'owner' } }),
    close: async () => { await started.catch(() => {}); await close(); },
    get service() { return service; },
  };
  if (lazy) return handle;
  await started;
  return handle;
}
