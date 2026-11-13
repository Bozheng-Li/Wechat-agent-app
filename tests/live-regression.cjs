/**
 * 实机回归（live regression）harness —— 仅本机所有者手动运行，不对真实聊天发消息。
 *
 * 运行（Electron 主进程脚本）：
 *   node_modules\electron\dist\electron.exe tests\live-regression.cjs
 *
 * 写入开关：
 *   LIVE_ALLOW_WRITES=1          允许 write / reversible 检查（否则全部 skipped）
 *   LIVE_MOMENTS=1               额外允许朋友圈发布 / 点赞 / 评论
 *   LIVE_MOMENTS_IRREVERSIBLE=1  额外允许「不可撤销」的点赞与评论
 *                                （朋友圈协议只有 like/comment/publish/delete，
 *                                  没有取消点赞、也没有删除评论的动作）
 *
 * 明确不做的事：不发聊天消息、不 connect/disconnect、不改数据目录、
 * 不改模型/默认助手/会话设置，不调用 providers.save、model.select、
 * model.configure、persona.save 一类写接口。
 *
 * 输出：artifacts/live/report.json、artifacts/live/report.md、artifacts/live/*.png
 */
const { app } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

// 入口固定在仓库根目录下的 desktop/main.cjs（本文件位于 <repo>/artifacts/）。
const ROOT = path.resolve(__dirname, '..');
const { runDesktop } = require(path.join(ROOT, 'desktop', 'main.cjs'));

app.disableHardwareAcceleration();
// 关掉窗口后仍要保留托盘服务，直到 finally 里主动关闭。
app.on('window-all-closed', () => {});

const DATA_HOME = 'E:\\微信机器人';
const OUT = path.join(ROOT, 'artifacts', 'live');
const WRITES = process.env.LIVE_ALLOW_WRITES === '1';
const MOMENTS = process.env.LIVE_MOMENTS === '1';
const IRREVERSIBLE = process.env.LIVE_MOMENTS_IRREVERSIBLE === '1';

const failures = [];
process.on('uncaughtException', error => failures.push('主进程异常: ' + (error?.stack || error)));
process.on('unhandledRejection', error => failures.push('主进程未处理拒绝: ' + (error?.stack || error)));

/* ------------------------------------------------------------------ 通用工具 */

class Skip extends Error {
  constructor(reason) { super(reason); this.name = 'Skip'; this.reason = reason; }
}

/** 详情里只允许出现计数、长度、布尔值：抹掉盘符路径、UNC 路径与 wxid。 */
function text(value) {
  return String(value ?? '')
    .replace(/[A-Za-z]:[\\/][^\s"'<>]*/g, '本机测试路径已隐藏')
    .replace(/\\\\[^\s"'<>]*/g, '本机测试路径已隐藏')
    .replace(/wxid_[0-9a-zA-Z]+/g, 'wxid_已隐藏')
    .replace(/\s+/g, ' ')
    .slice(0, 400);
}

function withTimeout(promise, ms, label) {
  let timer;
  const guarded = Promise.resolve(promise);
  // 超时后原 Promise 仍可能 reject，这里先消化掉，避免 unhandledRejection。
  guarded.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(text(label) + ' 超时（' + ms + 'ms）')), ms);
    timer.unref?.();
  });
  return Promise.race([guarded, timeout]).finally(() => clearTimeout(timer));
}

const sleep = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

async function waitFor(operation, timeoutMs, label, intervalMs = 1500) {
  const started = Date.now();
  let last;
  for (;;) {
    try { const value = await operation(); if (value) return value; } catch (error) { last = error; }
    if (Date.now() - started >= timeoutMs) throw last || new Error(text(label) + ' 等待超时');
    await sleep(intervalMs);
  }
}

/* ------------------------------------------------------- 纯 JS 生成一张小 PNG */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, body) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  const tag = Buffer.from(type, 'ascii');
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([tag, body])), 0);
  return Buffer.concat([header, tag, body, checksum]);
}

/** 尺寸 + 像素都随 seed 变化，保证每次运行的 SHA-256 都不同（避免命中旧素材而误删用户文件）。 */
function tinyPng(seed) {
  const width = 16 + (seed % 5);
  const height = 16;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // truecolor
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const at = row + 1 + x * 3;
      raw[at] = (seed + x * 7) & 0xff;
      raw[at + 1] = (seed + y * 13) & 0xff;
      raw[at + 2] = (seed ^ (x * y)) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------------------------------------------------------- 页面截图 */

const MASK_SCRIPT = String.raw`(() => {
  const hidden = '本机测试路径已隐藏';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const before = node.nodeValue;
    if (!before) continue;
    let after = before;
    if (/[A-Za-z]:[\\/]/.test(after)) after = after.replace(/[A-Za-z]:[\\/][^\s"'<>]*/g, hidden);
    if (/\\\\/.test(after)) after = after.replace(/\\\\[^\s"'<>]*/g, hidden);
    if (/wxid_[0-9a-zA-Z]+/.test(after)) after = after.replace(/wxid_[0-9a-zA-Z]+/g, 'wxid_已隐藏');
    if (after !== before) node.nodeValue = after;
  }
  for (const image of document.querySelectorAll('img, [class*="avatar"], [class*="Avatar"]')) image.style.filter = 'blur(6px)';
  document.title = '微信 Agent · 实机回归';
  return true;
})()`;

/* ------------------------------------------------------------------- 主体 */

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  let desktop = null;
  let exitCode = 0;

  const runCheck = async (check, ctx) => {
    const started = Date.now();
    const record = {
      id: check.id, title: check.title, kind: check.kind,
      ok: false, skipped: null, ms: 0, detail: '', error: null, cleanup: 'not-needed', cleanupNote: '',
    };
    const cleanup = { attempted: false, ok: null, note: '' };
    try {
      if (check.needsWrites && !WRITES) throw new Skip('write disabled (LIVE_ALLOW_WRITES!=1)');
      if (check.kind !== 'read' && !WRITES) throw new Skip('write disabled (LIVE_ALLOW_WRITES!=1)');
      if (check.momentsWrite && !MOMENTS) throw new Skip('LIVE_MOMENTS!=1');
      if (check.account && !ctx.accountId) throw new Skip('微信未连接或未登录');
      if (check.moments && !ctx.momentsRead) throw new Skip('朋友圈读取能力未就绪');
      const detail = await withTimeout(Promise.resolve().then(() => check.run(ctx, cleanup)), check.timeoutMs || 60000, check.id);
      record.ok = true;
      record.detail = text(detail || 'ok');
    } catch (error) {
      if (error instanceof Skip) record.skipped = error.reason;
      else record.error = text(error?.code ? error.code + '：' + error.message : (error?.message || String(error)));
    } finally {
      record.ms = Date.now() - started;
      // ok=true 已清理；ok=false 有残留；null 表示没走到改动那一步。
      record.cleanup = !cleanup.attempted ? 'not-needed' : cleanup.ok === true ? 'ok' : cleanup.ok === false ? 'failed' : 'unknown';
      record.cleanupNote = cleanup.note ? text(cleanup.note) : '';
      results.push(record);
      const state = record.ok ? 'OK  ' : record.skipped ? 'SKIP' : 'FAIL';
      console.log('[' + state + '] ' + record.id + ' (' + record.ms + 'ms) ' +
        (record.skipped || record.error || record.detail) + (record.cleanupNote ? ' | 清理:' + record.cleanup + ' ' + record.cleanupNote : ''));
    }
    return record;
  };

  try {
    desktop = await withTimeout(runDesktop({ dataHome: DATA_HOME, show: true }), 90000, '桌面启动');
    if (!desktop) throw new Error('runDesktop 返回 null：另一个实例正持有该数据目录的锁，未进行任何测试');
    const { window, application } = desktop;
    const call = (endpoint, payload) => application.call(endpoint, payload);
    const rpc = async (endpoint, payload = {}) => {
      const result = await call(endpoint, payload);
      if (!result || result.ok !== true) {
        const error = new Error(result?.error?.message || 'RPC 调用失败');
        error.code = result?.error?.code || 'RPC_FAILED';
        // moments.write 的 like 失败会带 delivery（not-sent / rejected），
        // 说明微信端到底有没有动过这条动态。
        if (result?.error?.delivery) {
          error.delivery = result.error.delivery;
          error.message += ' [delivery=' + result.error.delivery + ']';
        }
        throw error;
      }
      return result.value;
    };

    window.webContents.on('console-message', event => {
      if (event?.level === 'error' && failures.length < 20) failures.push('渲染进程错误: ' + text(event.message));
    });
    const js = code => withTimeout(window.webContents.executeJavaScript(code), 20000, '渲染进程执行');
    const capture = async name => {
      // 等页面把首屏数据渲染完，再截图（最多等 3 秒，失败不阻断）。
      await js('new Promise(resolve => setTimeout(() => resolve(true), 600))');
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
      await js(MASK_SCRIPT);
      const image = await withTimeout(window.webContents.capturePage(), 20000, '截图 ' + name);
      if (image.isEmpty()) throw new Error('截图内容为空（窗口可能被隐藏）');
      const file = path.join(OUT, name + '.png');
      fs.writeFileSync(file, image.toPNG());
      return fs.statSync(file).size;
    };
    const openPage = async (page, selector) => {
      const target = selector || '[data-testid="nav-' + page + '"]';
      await waitFor(() => js('!!document.querySelector(' + JSON.stringify(target) + ')'), 20000, '导航按钮 ' + page);
      await js('document.querySelector(' + JSON.stringify(target) + ').click()');
      await waitFor(() => js('document.querySelector(".wa-panel")?.dataset.page === ' + JSON.stringify(page) +
        ' && !!document.querySelector(".wa-page-head h1")'), 20000, '页面切换 ' + page);
    };

    /* -------- 等待微信连接（最多 90 秒） -------- */
    console.log('等待微信连接（最多 90 秒）…');
    const connectedStates = new Set(['online', 'connected', 'confirmed', 'logged-in', 'session-ready']);
    let status = null;
    const deadline = Date.now() + 90000;
    for (;;) {
      try { status = await rpc('status'); } catch (error) { status = null; }
      const login = String(status?.login?.state || '');
      if (status && (status.online === true || connectedStates.has(login)) && status.account?.id) break;
      if (Date.now() >= deadline) break;
      await sleep(2000);
    }
    const connected = Boolean(status && (status.online === true || connectedStates.has(String(status.login?.state || ''))) && status.account?.id);
    console.log(connected ? '微信已连接。' : '微信在 90 秒内未连接，账号相关检查将记为 skipped。');

    const accountId = connected ? status.account.id : null;
    const conversations = connected && Array.isArray(status.conversations) ? status.conversations : [];
    // 优先挑「文件传输助手」这类不会打扰真人的会话，其次任意私聊，最后群聊。
    const conversation =
      conversations.find(peer => /文件传输助手/.test(String(peer.name || ''))) ||
      conversations.find(peer => peer.chatType === 'private' && !String(peer.peerId).endsWith('@chatroom')) ||
      conversations.find(peer => peer.chatType === 'private') ||
      conversations[0] || null;

    const ctx = {
      accountId,
      conversation,
      momentsRead: connected && status?.capabilities?.momentsRead === true,
      momentsWrite: connected && status?.capabilities?.momentsWrite === true,
      vision: connected && status?.modelConfig?.vision === true,
      // 模型选择与 llm 目录不依赖微信登录，离线也能读。
      model: status?.model || status?.defaultModel || null,
      imageGeneration: status?.imageGeneration || null,
    };
    const uiRequestId = () => 'ui-moments-' + crypto.randomUUID();

    const target = (extra = {}) => ({
      ...(accountId ? { accountId } : {}),
      ...(conversation ? { chatType: conversation.chatType, peerId: conversation.peerId } : {}),
      ...extra,
    });

    /* ------------------------------------------------------------ 只读检查 */

    const readChecks = [
      {
        id: 'status', title: '运行状态', kind: 'read', run: async () => {
          const value = await rpc('status');
          return 'online=' + (value.online === true) + ' account=' + (value.account?.id ? 'present' : 'none') +
            ' login=' + (value.login?.state || 'unknown') + ' runtimeReady=' + (value.runtimeReady === true) +
            ' version=' + (value.version || '') + ' model=' + (value.model ? 'configured' : 'none') +
            ' momentsRead=' + (value.capabilities?.momentsRead === true) + ' momentsWrite=' + (value.capabilities?.momentsWrite === true) +
            ' conversations=' + (Array.isArray(value.conversations) ? value.conversations.length : 0);
        },
      },
      {
        id: 'changelog', title: '更新日志', kind: 'read', run: async () => {
          const value = await rpc('changelog');
          if (typeof value?.markdown !== 'string') throw new Error('CHANGELOG 内容不是 markdown 字符串');
          return 'markdownLength=' + value.markdown.length;
        },
      },
      {
        id: 'settings', title: '回复设置（只读，走 status）', kind: 'read', run: async () => {
          // settings 端点本身是「保存」写操作（validateSettings 必须有完整 payload），
          // 所以只读检查从 status().settings 取值，绝不提交写请求。
          const value = await rpc('status');
          const settings = value.settings || {};
          return 'enabled=' + (settings.enabled === true) + ' privatePeers=' + (settings.privatePeers?.length ?? 0) +
            ' groups=' + (settings.groups?.length ?? 0) + ' promptLength=' + String(settings.prompt || '').length +
            ' schedules=' + (settings.schedules ?? 'unset') + ' moments=' + (settings.moments ?? 'unset');
        },
      },
      {
        id: 'identity.get', title: '全局身份文件', kind: 'read', run: async () => {
          const value = await rpc('identity.get');
          return 'markdownLength=' + String(value.markdown || '').length + ' revision=' + String(value.revision || '').slice(0, 8);
        },
      },
      {
        id: 'model.info', title: '所选模型的推理强度', kind: 'read', run: async ctx => {
          if (!ctx.model) throw new Skip('当前未选择模型（status.model 为 null）');
          const value = await rpc('model.info', { selection: { provider: ctx.model.provider, model: ctx.model.model } });
          return 'provider=' + value.provider + ' model=' + value.model + ' reasoningEfforts=' + (value.reasoning?.efforts?.length ?? 0) +
            ' defaultEffort=' + (value.reasoning?.defaultEffort ? 'declared' : 'none');
        },
      },
      {
        id: 'providers.list', title: '模型服务列表（desktop）', kind: 'read', run: async () => {
          const value = await rpc('providers.list');
          const providers = value?.providers || [];
          return 'providers=' + providers.length + ' models=' + providers.reduce((sum, row) => sum + (row.models?.length || 0), 0);
        },
      },
      {
        id: 'models.catalog', title: '模型目录（desktop）', kind: 'read', run: async () => {
          // providers.catalog() 返回 { groups, default, failures }
          const value = await rpc('models.catalog');
          const groups = value?.groups || [];
          return 'groups=' + groups.length + ' models=' + groups.reduce((sum, row) => sum + (row.models?.length || 0), 0) +
            ' default=' + (value?.default ? 'set' : 'none') + ' failures=' + (value?.failures?.length ?? 0);
        },
      },
      {
        id: 'contacts', title: '联系人列表', kind: 'read', account: true, timeoutMs: 90000, run: async () => {
          const value = await rpc('contacts');
          return 'privatePeers=' + (value?.privatePeers?.length ?? 0) + ' groups=' + (value?.groups?.length ?? 0);
        },
      },
      {
        id: 'records.list', title: '会话记录分页', kind: 'read', account: true, run: async ctx => {
          if (!ctx.conversation) throw new Skip('没有已授权会话');
          const value = await rpc('records.list', target({ offset: 0, limit: 20 }));
          return 'total=' + (value.total ?? 0) + ' returned=' + (value.records?.length ?? 0) + ' hasMore=' + (value.hasMore === true);
        },
      },
      {
        id: 'memory.list', title: '会话记忆索引', kind: 'read', account: true, run: async () => {
          const value = await rpc('memory.list', { accountId });
          return 'conversations=' + (value.conversations?.length ?? 0) + ' windowChars=' + (value.windowChars ?? 0);
        },
      },
      {
        id: 'memory.global.get', title: '长期记忆', kind: 'read', account: true, run: async () => {
          const value = await rpc('memory.global.get', { accountId });
          return 'chars=' + (value.chars ?? String(value.markdown || '').length) + ' pendingCount=' + (value.pendingCount ?? 0) +
            ' sections=' + (value.sections?.length ?? 0) + ' revision=' + String(value.revision || '').slice(0, 8);
        },
      },
      {
        id: 'memory.role.list', title: '人物角色卡', kind: 'read', account: true, run: async () => {
          const value = await rpc('memory.role.list', { accountId });
          return 'people=' + (value.people?.length ?? 0) + ' scanning=' + (value.scanning === true) + ' errors=' + (value.errors?.length ?? 0);
        },
      },
      {
        id: 'memory.images.list', title: '会话图片记忆', kind: 'read', account: true, run: async ctx => {
          if (!ctx.conversation) throw new Skip('没有已授权会话');
          const value = await rpc('memory.images.list', target({ collection: 'conversation', offset: 0, limit: 10 }));
          return 'items=' + (value.items?.length ?? 0) + ' total=' + (value.total ?? 0) + ' collection=conversation';
        },
      },
      {
        id: 'assets.list', title: '素材库列表', kind: 'read', account: true, run: async () => {
          const value = await rpc('assets.list', { accountId, offset: 0, limit: 24 });
          return 'total=' + (value.total ?? 0) + ' items=' + (value.items?.length ?? 0) +
            ' packs=' + (value.packs?.length ?? 0) + ' enabled=' + (value.counts?.enabled ?? 0) +
            ' described=' + (value.counts?.described ?? 0);
        },
      },
      {
        id: 'assets.describe', title: '素材理解（会写入说明）', kind: 'read', account: true, needsWrites: true, timeoutMs: 120000,
        run: async ctx => {
          // 会在真实素材上重写说明，默认不跑；显式 LIVE_ASSETS_DESCRIBE=1 才执行。
          if (process.env.LIVE_ASSETS_DESCRIBE !== '1') throw new Skip('默认跳过（会改写真实素材说明），需要 LIVE_ASSETS_DESCRIBE=1');
          if (!ctx.vision) throw new Skip('模型高级设置未开启图像理解');
          const library = await rpc('assets.list', { accountId, offset: 0, limit: 1 });
          const asset = library.items?.[0];
          if (!asset) throw new Skip('素材库为空，没有可理解的素材');
          const progress = await rpc('assets.describe', { accountId, assetIds: [asset.id] });
          return 'total=' + (progress.total ?? 0) + ' succeeded=' + (progress.succeeded ?? 0) +
            ' failed=' + (progress.failed ?? 0) + ' skipped=' + (progress.skipped ?? 0);
        },
      },
      {
        id: 'tasks.list', title: '定时任务列表', kind: 'read', account: true, run: async () => {
          const value = await rpc('tasks.list', { accountId });
          return 'tasks=' + (value.tasks?.length ?? 0) + ' runs=' + (value.runs?.length ?? 0) + ' error=' + (value.error ? 'present' : 'none');
        },
      },
      {
        id: 'time.list', title: '时间设置分组', kind: 'read', run: async () => {
          // 不传 accountId 时只返回全局分组；传了才会校验当前账号。
          const value = await rpc('time.list', accountId ? { accountId } : {});
          return 'groups=' + (value.groups?.length ?? 0) +
            ' accountGroups=' + (value.groups || []).filter(group => group.category === '当前微信账号').length;
        },
      },
      {
        id: 'moments.list', title: '朋友圈自动化状态', kind: 'read', account: true, moments: true, run: async () => {
          const value = await rpc('moments.list', { accountId });
          return 'posts=' + (value.posts?.length ?? 0) + ' replies=' + (value.replies?.length ?? 0) +
            ' plans=' + (value.publishing?.plans?.length ?? 0) + ' runs=' + (value.publishing?.runs?.length ?? 0) +
            ' schedulerStarted=' + (value.schedulerStarted === true);
        },
      },
      {
        id: 'moments.read', title: '读取好友朋友圈时间线', kind: 'read', account: true, moments: true, timeoutMs: 90000, run: async () => {
          const value = await rpc('moments.read', { accountId, action: 'timeline', limit: 20 });
          const items = value.items || [];
          return 'items=' + items.length + ' source=' + (value.source || '') +
            ' friends=' + items.filter(post => post.author?.userId && post.author.userId !== accountId).length +
            ' nextCursor=' + (value.nextCursor ? 'present' : 'none');
        },
      },
      {
        id: 'moments.discover', title: '扫描并刷新朋友圈缓存', kind: 'read', account: true, moments: true, timeoutMs: 150000, run: async () => {
          const value = await rpc('moments.discover', { accountId });
          return 'posts=' + (value.posts?.length ?? 0) + ' error=' + (value.error ? 'present' : 'none');
        },
      },
      {
        id: 'storage.data-root', title: '数据目录信息（desktop）', kind: 'read', run: async () => {
          const value = await rpc('storage.data-root');
          return 'sameAsPlugin=' + (value.sameAsPlugin === true) + ' hasPointer=' + Boolean(value.pointer) +
            ' currentReadable=' + Boolean(value.current) + ' lastSwitchError=' + (value.lastSwitchError ? 'present' : 'none');
        },
      },
      {
        id: 'cleanup.preview', title: '清理范围预览', kind: 'read', account: true, timeoutMs: 90000, run: async () => {
          const kinds = ['moments.publishing', 'moments.likes.runs', 'moments.likes.records', 'moments.replies',
            'moments.interactions', 'moments.materials', 'tasks.history', 'digests'];
          let checked = 0, rows = 0, guarded = 0, failed = 0;
          for (const kind of kinds) {
            try {
              const value = await rpc('cleanup.preview', { accountId, kind });
              checked++; rows += value.count ?? 0; guarded += value.protectedCount ?? 0;
            } catch { failed++; }
          }
          return 'kindsChecked=' + checked + '/' + kinds.length + ' previewRows=' + rows + ' protectedRows=' + guarded + ' rejected=' + failed;
        },
      },
      {
        id: 'administrators.candidates', title: '管理员候选名单', kind: 'read', account: true, timeoutMs: 90000, run: async () => {
          const value = await rpc('administrators.candidates', { accountId });
          return 'users=' + (value.users?.length ?? 0) + ' groups=' + (value.groups?.length ?? 0);
        },
      },
      {
        id: 'imageGeneration.configure', title: '生图接口配置（只读取 status）', kind: 'read', run: async ctx => {
          // imageGeneration.configure 是「保存」写操作，且它的 settings 必须是
          // { enabled, defaultProviderId, providers[] } 的干净对象：
          // status() 额外返回的 credentialStore/endpoint/model/… 会被
          // imageGenerationSettings 判为非法字段，因此这里不能把 status 原样回写。
          const value = ctx.imageGeneration || (await rpc('status')).imageGeneration || {};
          return 'enabled=' + (value.enabled === true) + ' providers=' + (value.providers?.length ?? 0) +
            ' defaultProvider=' + (value.defaultProviderId ? 'set' : 'none') +
            ' credentialConfigured=' + (value.credentialConfigured === true) +
            ' credentialStore=' + (value.credentialStore === true) +
            ' providerCredentials=' + (value.providers || []).filter(row => row.credentialConfigured === true).length;
        },
      },
    ];

    /* -------------------------------------------------- 可逆写入 / 有副作用检查 */

    const writeChecks = [
      {
        id: 'tasks.create+cancel', title: '创建并取消一次性提醒', kind: 'reversible', account: true,
        run: async (ctx, cleanup) => {
          if (!ctx.conversation) throw new Skip('没有已授权会话，无法创建提醒');
          cleanup.attempted = true;
          const before = await rpc('tasks.list', { accountId });
          const known = new Set((before.tasks || []).map(task => task.id));
          // 定在 6 小时后：远晚于本次运行（留出手工补取消的时间窗），且立即取消，
          // 正常路径不会真的发出消息；targets 为空数组时不会 @ 任何人。
          const at = Date.now() + 6 * 60 * 60 * 1000;
          const requestId = 'live-' + crypto.randomUUID();
          const newTasks = async () => ((await rpc('tasks.list', { accountId })).tasks || []).filter(task => !known.has(task.id));
          const cancel = async id => rpc('tasks.cancel', { accountId, taskId: id });
          let taskId = null, failure = null, appeared = false, cancelled = false;
          try {
            await rpc('tasks.create', target({
              requestId,
              task: { kind: 'message', content: 'LIVE 回归自检提醒（应立即取消，请忽略）', schedule: { kind: 'once', at }, targets: [] },
            }));
            const created = await newTasks();
            if (created.length !== 1) throw new Error('新建提醒后新增任务数为 ' + created.length + '（预期 1）');
            taskId = created[0].id;
            appeared = created[0].state === 'pending' && created[0].schedule?.kind === 'once';
            if (!appeared) throw new Error('新任务状态不是 pending/once：state=' + created[0].state);
            await cancel(taskId);
            const final = await rpc('tasks.list', { accountId });
            const task = (final.tasks || []).find(row => row.id === taskId);
            if (!task) throw new Error('取消后仍找不到该任务记录');
            cancelled = task.state === 'cancelled';
            if (!cancelled) throw new Error('取消后任务状态仍为 ' + task.state);
          } catch (error) { failure = error; }
          if (!cancelled) {
            // 结果不明时按列表差异把所有新增任务都取消，绝不留定时发送。
            try {
              const leftovers = await newTasks();
              if (!taskId && leftovers.length) cleanup.note = '按列表差异找回新增任务';
              for (const task of leftovers) await cancel(task.id);
              const final = await rpc('tasks.list', { accountId });
              cancelled = !(final.tasks || []).some(row => !known.has(row.id) && row.state === 'pending');
              if (cancelled) taskId ??= leftovers[0]?.id || null;
            } catch (error) { cleanup.note = '补取消失败：' + (error.code || error.message); }
          }
          cleanup.ok = cancelled;
          if (failure) throw failure;
          return 'appeared=' + appeared + ' cancelled=' + cancelled + ' schedule=once(+6h) targets=0';
        },
      },
      {
        id: 'assets.import+edit+delete', title: '导入 / 编辑 / 删除一张自检图片', kind: 'reversible', account: true, timeoutMs: 120000,
        run: async (ctx, cleanup) => {
          cleanup.attempted = true;
          const seed = Date.now() & 0xff;
          const png = tinyPng(seed);
          const name = 'live-regression-' + Date.now() + '.png';
          let assetId = null, edited = false, removed = false, failure = null;
          try {
            const imported = await rpc('assets.import', { accountId, name, kind: 'image', data: png.toString('base64') });
            if (imported.imported !== 1 || imported.assetIds?.length !== 1)
              throw new Error('导入未新增 1 张（imported=' + imported.imported + ' duplicates=' + imported.duplicates + '），未改动任何已有素材');
            assetId = imported.assetIds[0];
            const listed = await rpc('assets.list', { accountId, query: 'live-regression', limit: 10 });
            const created = (listed.items || []).find(item => item.id === assetId);
            if (!created) throw new Error('导入后素材库中找不到这张素材');
            if (created.kind !== 'image' || created.bytes !== png.length)
              throw new Error('导入结果与本地文件不一致：kind=' + created.kind + ' bytes=' + created.bytes);
            const patched = await rpc('assets.edit', {
              accountId, assetId,
              patch: { name: 'live-regression-edited.png', description: '本机实机回归自检素材', revision: created.revision },
            });
            edited = patched.name === 'live-regression-edited.png' && patched.description === '本机实机回归自检素材';
            if (!edited) throw new Error('编辑后名称或说明未更新');
            await rpc('assets.delete', { accountId, assetIds: [assetId] });
            const after = await rpc('assets.list', { accountId, query: 'live-regression', limit: 10 });
            removed = !(after.items || []).some(item => item.id === assetId);
            if (!removed) throw new Error('删除后素材仍在列表中');
          } catch (error) { failure = error; }
          if (!removed && assetId) {
            try {
              await rpc('assets.delete', { accountId, assetIds: [assetId] });
              const after = await rpc('assets.list', { accountId, query: 'live-regression', limit: 10 });
              removed = !(after.items || []).some(item => item.id === assetId);
            } catch (error) { cleanup.note = '补删除失败：' + (error.code || error.message); }
          }
          cleanup.ok = removed;
          if (failure) throw failure;
          return 'imported=1 edited=' + edited + ' deleted=' + removed + ' bytes=' + png.length;
        },
      },
      {
        id: 'moments.drafts.edit+discard', title: '生成草稿 → 编辑 → 放弃', kind: 'reversible', account: true, momentsWrite: true, timeoutMs: 260000,
        run: async (ctx, cleanup) => {
          // 只有 moments.plans.preview 能产生 draft 状态的 run；编辑/放弃都要求已存在的草稿。
          const settings = {
            name: 'LIVE 回归自检草稿', enabled: false, themes: ['本机回归自检'], style: '自然、简短',
            instructions: '仅用于本机实机回归自检，不发布', maxChars: 300, useMaterials: false, reviewRequired: true,
            research: false, researchQuery: '', graceMinutes: 60, blockedLabelIds: [], blockedUserIds: [],
            schedule: { type: 'daily', timezone: 'Asia/Shanghai', times: ['09:00'], weekdays: [1, 2, 3, 4, 5], onceAt: '' },
            image: { mode: 'none', providerId: '', model: '', size: '', instructions: '' },
          };
          cleanup.attempted = true;
          let runId = null, discarded = false, edited = false, failure = null;
          try {
            const run = await rpc('moments.plans.preview', { accountId, requestId: uiRequestId(), settings });
            runId = run?.id || null;
            if (!runId) throw new Error('预览没有返回草稿编号');
            if (run.state !== 'draft') throw new Error('预览结果不是 draft，而是 ' + run.state);
            const editText = '本机实机回归自检草稿，稍后立即放弃。' + Date.now();
            const listAfterEdit = await rpc('moments.drafts.edit', { accountId, id: runId, text: editText });
            const editedRun = (listAfterEdit.runs || []).find(row => row.id === runId);
            edited = editedRun?.text === editText;
            if (!edited) throw new Error('草稿正文未更新');
            await rpc('moments.drafts.discard', { accountId, id: runId });
            const final = await rpc('moments.list', { accountId });
            const row = (final.publishing?.runs || []).find(item => item.id === runId);
            discarded = row?.state === 'discarded';
            if (!discarded) throw new Error('放弃后草稿状态为 ' + (row?.state ?? 'missing'));
          } catch (error) { failure = error; }
          if (!discarded && runId) {
            try {
              await rpc('moments.drafts.discard', { accountId, id: runId });
              const final = await rpc('moments.list', { accountId });
              discarded = ((final.publishing?.runs || []).find(item => item.id === runId))?.state === 'discarded';
            } catch (error) { cleanup.note = '补放弃失败：' + (error.code || error.message) + '（草稿编号已保留在 stdout 之外）'; }
          }
          cleanup.ok = discarded;
          if (failure) throw failure;
          return 'draftCreated=true edited=' + edited + ' discarded=' + discarded + ' textOnly=true';
        },
      },
      {
        id: 'moments.write.like', title: '点赞好友动态（协议无取消点赞）', kind: 'reversible', account: true,
        momentsWrite: true, timeoutMs: 120000,
        run: async (ctx, cleanup) => {
          if (!IRREVERSIBLE)
            throw new Skip('朋友圈协议只支持 like/comment/publish/delete，没有取消点赞动作；为避免不可撤销的社交操作，需 LIVE_MOMENTS_IRREVERSIBLE=1');
          cleanup.attempted = true;
          const feed = await rpc('moments.read', { accountId, action: 'timeline', limit: 20 });
          const post = (feed.items || []).find(item => item.author?.userId && item.author.userId !== accountId &&
            item.contentAvailable !== false && item.deleted !== true && item.likedByCurrentAccount !== true);
          if (!post) throw new Skip('没有找到可点赞的好友动态（作者非本人且未点赞）');
          // 一旦点赞发出就无法撤销，先把清理状态标成「有残留」。
          cleanup.ok = false;
          cleanup.note = '无法撤销：协议没有 unlike，点赞会保留';
          let receipt;
          try {
            receipt = await rpc('moments.write', { accountId, action: 'like', postId: post.id, requestId: uiRequestId() });
          } catch (error) {
            if (error.delivery === 'not-sent') { cleanup.ok = null; cleanup.note = '点赞未送达微信，没有留下点赞记录'; }
            throw error;
          }
          const detail = await rpc('moments.read', { accountId, action: 'detail', postId: post.id });
          const liked = detail.items?.[0]?.likedByCurrentAccount === true ||
            (detail.items?.[0]?.likes || []).some(row => row.userId === accountId);
          if (!liked) throw new Error('点赞回执成功但详情里看不到自己的点赞');
          return 'liked=true delivery=' + (receipt?.delivery || 'sent') + ' unlikeSupported=false';
        },
      },
      {
        id: 'moments.write.comment', title: '评论好友动态（协议无删除评论）', kind: 'reversible', account: true,
        momentsWrite: true, timeoutMs: 120000,
        run: async (ctx, cleanup) => {
          if (!IRREVERSIBLE)
            throw new Skip('朋友圈协议没有删除评论的动作，评论无法撤回；需 LIVE_MOMENTS_IRREVERSIBLE=1');
          cleanup.attempted = true;
          const feed = await rpc('moments.read', { accountId, action: 'timeline', limit: 20 });
          const post = (feed.items || []).find(item => item.author?.userId && item.author.userId !== accountId &&
            item.contentAvailable !== false && item.deleted !== true);
          if (!post) throw new Skip('没有找到可评论的好友动态（作者非本人）');
          const body = '实机回归自检评论 ' + Date.now().toString(36);
          // 评论同样无法撤回，先按「有残留」记录。
          cleanup.ok = false;
          cleanup.note = '无法撤销：协议没有删除评论，评论会保留';
          let receipt;
          try {
            receipt = await rpc('moments.write', { accountId, action: 'comment', postId: post.id, text: body, requestId: uiRequestId() });
          } catch (error) {
            if (error.delivery === 'not-sent') { cleanup.ok = null; cleanup.note = '评论未送达微信，没有留下评论'; }
            throw error;
          }
          const comments = await rpc('moments.read', { accountId, action: 'comments', postId: post.id, limit: 50 });
          const found = (comments.items || []).some(row => row.id === receipt.commentId && row.userId === accountId && row.text === body);
          if (!found) throw new Error('评论回执成功但评论区里找不到这条评论');
          return 'commentIdReturned=' + Boolean(receipt.commentId) + ' textLength=' + body.length +
            ' delivery=' + (receipt?.delivery || 'sent') + ' commentDeleteSupported=false';
        },
      },
      {
        id: 'moments.write.publish+delete', title: '发布纯文字朋友圈并立即删除（60 秒预算）', kind: 'reversible',
        account: true, momentsWrite: true, timeoutMs: 120000,
        run: async (ctx, cleanup) => {
          const stamp = new Date().toISOString().slice(0, 19);
          const body = '【本机实机回归自检】' + stamp + '，发布后立即删除。';
          cleanup.attempted = true;
          const deadline = Date.now() + 60000;
          const remain = () => Math.max(0, deadline - Date.now());
          const readOwn = limit => rpc('moments.read', { accountId, action: 'user', userId: accountId, limit });
          const readTimeline = () => rpc('moments.read', { accountId, action: 'timeline', limit: 20 });
          // PC 端「自己的主页」对新发的纯文字动态可能滞后（源码注释亦如此），
          // 所以首页确认同时看 user 主页与 timeline，两者都按时间倒序。
          const locate = async query => {
            const feeds = [];
            try { feeds.push(['user', await readOwn(5)]); } catch (error) { feeds.push(['user', null]); }
            try { feeds.push(['timeline', await readTimeline()]); } catch (error) { feeds.push(['timeline', null]); }
            for (const [name, feed] of feeds) {
              const index = (feed?.items || []).findIndex(query);
              if (index >= 0) return { feed: name, index };
            }
            return null;
          };
          const gone = async () => {
            const feeds = [];
            try { feeds.push(await readOwn(5)); } catch (error) { feeds.push(null); }
            try { feeds.push(await readTimeline()); } catch (error) { feeds.push(null); }
            const absent = feeds.filter(Boolean).every(feed => (feed.items || []).every(item => item.id !== postId));
            let unreadable = false;
            try {
              const detail = await rpc('moments.read', { accountId, action: 'detail', postId });
              unreadable = detail?.items?.[0]?.deleted === true || !detail?.items?.length;
            } catch (error) { unreadable = true; }
            return absent && unreadable;
          };
          const deletePost = async id => rpc('moments.write', { accountId, action: 'delete', postId: id, requestId: uiRequestId() });
          let postId = null, deleted = false, found = null, failure = null;
          try {
            const receipt = await withTimeout(
              rpc('moments.write', { accountId, action: 'publish', text: body, requestId: uiRequestId() }),
              Math.max(8000, Math.min(45000, remain())), '发布朋友圈',
            );
            postId = receipt?.postId || null;
            if (!postId) throw new Error('发布回执没有动态编号');
            if (receipt.text !== body || receipt.imageCount !== 0) throw new Error('发布回执与提交内容/图片数不一致');
            found = await waitFor(
              () => locate(item => item.id === postId),
              Math.max(5000, Math.min(12000, remain())), '发布后复查自己的朋友圈',
            ).catch(() => null);
            if (remain() < 6000) throw new Error('发布核对已用尽 60 秒预算，未执行删除，交由清理补删');
            await deletePost(postId);
            deleted = await waitFor(gone, Math.max(5000, Math.min(18000, remain())), '删除后复查');
          } catch (error) { failure = error; }
          if (!deleted) {
            // 结果不明（超时/回执缺失）时，按正文在自己主页 / 时间线顶部找回并补删。
            if (!postId) {
              try {
                const hit = await locate(item => item.text === body);
                const feed = hit?.feed === 'timeline' ? await readTimeline() : await readOwn(5);
                postId = (feed?.items || []).find(item => item.text === body)?.id || null;
                if (postId) cleanup.note = '回执缺失，已按正文找回动态';
              } catch (error) { cleanup.note = '复查主页失败：' + (error.code || error.message); }
            }
            if (postId) {
              for (let attempt = 0; attempt < 2 && !deleted; attempt++) {
                try {
                  await deletePost(postId);
                  deleted = await gone();
                } catch (error) { cleanup.note = '补删失败：' + (error.code || error.message); }
              }
            } else cleanup.note = '未能确定新动态编号，请在微信里人工核对';
          }
          cleanup.ok = deleted;
          if (failure) throw failure;
          if (!found) throw new Error('发布与删除都已完成，但未能确认新动态出现在自己的朋友圈首位（可能只是读取滞后）');
          return 'published=true foundIn=' + found.feed + ' feedIndex=' + found.index + ' imageCount=0 deleted=' + deleted +
            ' textLength=' + body.length + ' budgetMs=60000';
        },
      },
      {
        id: 'imageGeneration.generate+import', title: '生图 → 导入素材库 → 删除', kind: 'reversible', account: true, timeoutMs: 240000,
        run: async (ctx, cleanup) => {
          const generation = ctx.imageGeneration || (await rpc('status')).imageGeneration || {};
          if (!generation.enabled) throw new Skip('生图未启用（imageGeneration.enabled=false）');
          if (generation.credentialConfigured !== true) throw new Skip('默认生图接口未保存密钥');
          cleanup.attempted = true;
          // 本仓库没有任何「直接生图」RPC：application 只有 call/close，
          // 不是 service 句柄，ImageGenerationService.generate 只能经
          // moments.materials.generate（素材库按需生图）这一条 RPC 路径驱动。
          const requestId = 'live-regression-' + crypto.randomUUID();
          let material = null, assetId = null, removedAsset = false, removedMaterial = false, failure = null;
          let mediaType = 'unknown', byteLength = 0;
          try {
            const generated = await rpc('moments.materials.generate', {
              accountId, requestId, prompt: '一张纯色几何测试图，仅用于本机实机回归自检', title: 'LIVE 回归自检',
            });
            material = generated?.item || null;
            if (!material?.id) throw new Error('素材库生图没有返回素材编号');
            const image = await rpc('moments.materials.image', { accountId, id: material.id });
            if (typeof image?.data !== 'string' || !image.data) throw new Error('生图素材没有返回图片字节');
            const bytes = Buffer.from(image.data, 'base64');
            mediaType = image.mediaType || 'unknown';
            byteLength = bytes.length;
            const extension = image.mediaType === 'image/jpeg' ? '.jpg' : '.png';
            const imported = await rpc('assets.import', {
              accountId, name: 'live-regression-gen-' + Date.now() + extension, kind: 'image', data: bytes.toString('base64'),
            });
            if (imported.imported !== 1 || imported.assetIds?.length !== 1)
              throw new Error('生图字节导入素材库未新增 1 张（imported=' + imported.imported + '）');
            assetId = imported.assetIds[0];
            const listed = await rpc('assets.list', { accountId, query: 'live-regression-gen', limit: 10 });
            const created = (listed.items || []).find(item => item.id === assetId);
            if (!created || created.bytes !== bytes.length) throw new Error('导入的生成图字节数与来源不一致');
            await rpc('assets.delete', { accountId, assetIds: [assetId] });
            const after = await rpc('assets.list', { accountId, query: 'live-regression-gen', limit: 10 });
            removedAsset = !(after.items || []).some(item => item.id === assetId);
            if (!removedAsset) throw new Error('生成图删除后仍在素材库');
          } catch (error) { failure = error; }
          if (material?.id && !removedMaterial) {
            try {
              await rpc('moments.materials.delete', { accountId, id: material.id, revision: material.revision });
              removedMaterial = true;
            } catch (error) { cleanup.note = '朋友圈素材清理失败：' + (error.code || error.message); }
          }
          if (!removedAsset && assetId) {
            try {
              await rpc('assets.delete', { accountId, assetIds: [assetId] });
              removedAsset = true;
            } catch (error) { cleanup.note = '补删素材失败：' + (error.code || error.message); }
          }
          cleanup.ok = removedAsset && removedMaterial;
          if (failure) {
            if (failure.code === 'MOMENTS_MATERIAL_GENERATE_DISABLED')
              throw new Skip('素材库按需生图未开启，且没有其它 RPC 能驱动 ImageGenerationService.generate');
            throw failure;
          }
          return 'providerDriven=true materialDeleted=' + removedMaterial + ' assetImportedAndDeleted=' + removedAsset +
            ' mediaType=' + mediaType + ' bytes=' + byteLength;
        },
      },
    ];

    for (const check of [...readChecks, ...writeChecks]) await runCheck(check, ctx);

    /* ---------------------------------------------------------------- 截图 */

    const shots = [
      { id: 'screenshot.overview', name: 'overview', page: 'overview' },
      { id: 'screenshot.memory', name: 'memory', page: 'memory' },
      { id: 'screenshot.moments', name: 'moments', page: 'moments' },
      { id: 'screenshot.assets', name: 'assets', page: 'assets' },
      { id: 'screenshot.tasks', name: 'tasks', page: 'tasks' },
      { id: 'screenshot.settings-models', name: 'settings-models', page: 'model', open: 'open-model', from: 'settings' },
      { id: 'screenshot.settings-image', name: 'settings-image', page: 'image-generation', open: 'open-image-generation', from: 'settings' },
      { id: 'screenshot.settings-storage', name: 'settings-storage', page: 'storage', open: 'open-storage', from: 'settings' },
    ];
    for (const shot of shots) {
      await runCheck({
        id: shot.id, title: '截图 ' + shot.name, kind: 'read', timeoutMs: 60000,
        run: async () => {
          if (shot.open) {
            await openPage(shot.from || 'settings');
            await openPage(shot.page, '[data-testid="' + shot.open + '"]');
          } else {
            await openPage(shot.page);
          }
          const bytes = await capture(shot.name);
          return 'file=live/' + shot.name + '.png bytes=' + bytes;
        },
      }, ctx);
    }
  } catch (error) {
    exitCode = 1;
    console.error('运行失败：' + (error?.stack || error));
    failures.push('运行失败: ' + text(error?.message || error));
  } finally {
    try {
      // runDesktop 在本仓库返回 { stop }；若将来补上 close()，优先使用它。
      if (desktop) {
        if (typeof desktop.close === 'function') await desktop.close();
        else if (typeof desktop.stop === 'function') await desktop.stop();
        else await desktop.application?.close?.();
      }
    } catch (error) {
      console.error('关闭失败：' + (error?.message || error));
    }
    const failed = results.filter(row => !row.ok && !row.skipped).length;
    try { writeReports(results, failures); }
    catch (error) { console.error('写报告失败：' + (error?.message || error)); }
    // 给 stdout 一点时间落盘，再退出（Electron 退出会立刻结束进程）。
    await sleep(300);
    app.exit(exitCode || (failed ? 1 : 0));
  }
}

function writeReports(results, runtimeFailures = []) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(row => !row.ok && !row.skipped).length;
  const skipped = results.filter(row => row.skipped).length;
  const passed = results.filter(row => row.ok).length;
  let version = 'unknown';
  try { version = require('../package.json').version; } catch {}
  const lines = [
    '# 实机回归报告',
    '',
    '- 时间：' + new Date().toISOString(),
    '- 应用版本：' + version,
    '- 系统：' + os.type() + ' ' + os.release() + ' ' + (os.version ? os.version() : ''),
    '- 数据目录：`E:\\微信机器人`（任务指定）',
    '- 写入门槛：LIVE_ALLOW_WRITES=' + (WRITES ? '1' : '0') + '，LIVE_MOMENTS=' + (MOMENTS ? '1' : '0') +
      '，LIVE_MOMENTS_IRREVERSIBLE=' + (IRREVERSIBLE ? '1' : '0'),
    '- 结果：通过 ' + passed + '，跳过 ' + skipped + '，失败 ' + failed + '，共 ' + results.length,
    '',
    '| id | kind | 状态 | ms | detail / error | 清理 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of results) {
    const state = row.ok ? 'ok' : row.skipped ? 'skipped' : 'failed';
    const note = row.skipped ? 'skipped (' + row.skipped + ')' : row.ok ? row.detail : row.error;
    lines.push('| ' + row.id + ' | ' + row.kind + ' | ' + state + ' | ' + row.ms + ' | ' +
      String(note || '').replace(/\|/g, '\\|') + ' | ' + row.cleanup + (row.cleanupNote ? '：' + row.cleanupNote.replace(/\|/g, '\\|') : '') + ' |');
  }
  if (runtimeFailures.length) {
    lines.push('', '## 运行期异常', '');
    for (const row of runtimeFailures) lines.push('- ' + text(row));
  }
  lines.push('', '截图：`artifacts/live/*.png`（截图前已抹掉盘符路径、wxid，并模糊头像）。', '');
  fs.writeFileSync(path.join(OUT, 'report.md'), lines.join('\n'));
  console.log('');
  console.log('实机回归：通过 ' + passed + ' / 跳过 ' + skipped + ' / 失败 ' + failed + ' / 共 ' + results.length +
    '；报告：artifacts/live/report.md' + (failed ? '（存在失败项，退出码 1）' : ''));
}

main().catch(error => {
  console.error(error);
  app.exit(1);
});
