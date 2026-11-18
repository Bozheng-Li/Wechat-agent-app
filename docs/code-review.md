# 代码审查报告（2026-11-17）

范围：`backend/`、`modules/`、`shared/`、`frontend/`、`desktop/`、`scripts/`、`tests/`、`prompts/`。
方法：先建立可重复基线（构建 + 全量隔离测试），再按领域通读源码并逐个用调用方确认可达性；子代理并行审查 8 个领域，高优先级结论由本人复核代码后才计入本报告。

## 一、基线（动手前）

| 项目 | 结果 |
|---|---|
| `node scripts/build.mjs` | 通过，产出 `lib/app.js`、`lib/worker.cjs`、`ui/app.js` |
| `node scripts/test.mjs` | **1052 项通过 / 0 失败**，耗时 810.9 s |
| 单个测试最长耗时 | `observed context retains only its latest 1000 messages…` **50.6 s**；`records remain independently pageable…` **15.6 s** |
| 类型检查 / Lint | **不存在**：无 `tsconfig.json`、无 eslint、`typescript` 不在依赖里；`.ts` 文件只被 rolldown 剥掉类型 |
| CI | 不存在（无 `.github/`） |

结论：主套件是绿的，所以“当前问题”不是红色测试，而是**潜在的正确性缺陷、无上限增长与成本失控**，以及**测试覆盖面本身在漏**。

## 二、已修复（本轮改动，含回归测试）

全部改动都补了测试并重跑全量套件（见第五节）。

### 1. 锁文件被崩溃截断后，应用永久无法启动（P0）

`backend/storage/locks.mjs`：`openSync(file,'wx')` 与写入 JSON 正文之间存在崩溃窗口（且没有 fsync）。留下的空文件/半截 JSON 会让 `owner()` 返回 `undefined`，而 `acquireLock` 与 `archiveLock` 都把 `undefined` 当作“另一个实例在写”直接抛错。全仓没有任何按年龄回收的代码，于是 `owner.lock` 一旦为空，**每次启动都必然 `OWNER_BUSY`，重启无效**，用户只能手工删除隐藏文件；会话级 `.wechat-agent-write.lock` 为空则让该会话永久写不进去。

修法：`owner()` 仍返回 `undefined` 表示“读不出来”，但新增 `reapUnreadable(file)`——读不出来且 mtime 超过 5 s（锁的写入窗口是微秒级）即判为尸体并回收，然后重试一次 `openSync('wx')`；5 s 内则保持原判定，不抢正在创建的锁。

### 2. 释放锁失败会把“已成功写入”报成失败，并让该会话此后永久失败（P0）

`archive.mjs` 的 `finally { release?.() }` 里一旦抛错会**覆盖成功的写入结果**；`state-store` 随即回滚内存 revision，而磁盘上的 `conversation.json` 已经是新版本，下一次保存必然 revision 冲突，且残留的本进程锁让后续写入报“正由另一个实例写入”。

修法：`release()` 对 `unlink` 做 5 次退避重试（与 `atomicJson` 对 Windows `EPERM/EBUSY` 的重试哲学一致）；仍失败时**不再抛出**（写入已提交，不能倒因为果），而是把该 token 记入 `stuckLocks`，下一次 `archiveLock` 见到自己的 token 就回收，不会误删别人的锁。

### 3. 残留的原子写临时文件让会话目录永久不可写（P0）

`atomicJson` 通过 `conversation.json.<pid>.<uuid>.tmp` 发布，崩溃会留下它；而 `writeArchiveSnapshot` 判空目录时只容忍 `.wechat-agent-write.lock`，于是**自己刚写的 tmp 反而让它判定“非空目录”**并抛 `CONVERSATION_PATH_CONFLICT`。该目录名由 `conversationFolder()` 确定性生成、用户无法换路径，异常再经 `channel.fail()` 停掉全部自动回复。

修法：判空时把匹配 `^conversation\.json\.\d+\.[0-9a-f-]{36}\.tmp$` 的文件视为自己的残留，在锁内顺手删除；其它任何文件仍然拒绝（安全属性不变，有测试守住）。

### 4. DeepSeek 搜索失败分支不释放响应体（P1）

`modules/search/service.mjs` 的 `!response.ok` 分支直接抛错，未 `response.body?.cancel()`（Tavily 分支有）。密钥错误或限流时每次失败都挂住一个 socket 直到 GC。

修法：与 Tavily 分支对齐，先 `await response.body?.cancel()` 再映射错误码。

### 5. 前端 RPC 层吞掉原始错误（P2）

`frontend/shared/rpc.mjs` 的 `catch {` 无绑定变量，超时、主动 abort 与主进程崩溃在 UI 上完全不可区分，依赖 `failure.code` 的分支也永远走不到。顺带修掉文案里多出的空格（“请检查 应用连接”）。

修法：`catch (cause)` → 保留 `error.cause`，并按 `AbortError` 标记 `RPC_ABORTED` / `RPC_UNAVAILABLE`，文案与既有行为不变。

### 6. 授权页“同步已发现会话”失败后不再重试、且切 tab 会重复请求（P2）

`frontend/hooks/use-panel.mjs` 的 effect 依赖漏了 `contacts`（失败后 `contacts` 仍是 `null`，依赖不变 → 永不重试），却多列了函数体内根本没用的 `authTab`（每切一次 tab 就多发一次 `contacts`）。

修法：依赖改为 `[page, status?.online, status?.account?.id, contacts]`。

### 7. 轨迹页翻到第 2 页后定时器空转（P3）

`frontend/pages/traces/page.jsx` 无条件注册 5 s 定时器、在回调里才判断 `offset === 0`，翻页后每 5 s 白醒一次。

修法：条件提到注册处，`offset !== 0` 时不再注册，并在 cleanup 里判空。

### 8. 会话设置保存路径的潜在空指针（P2）

`frontend/page-content.jsx` 同一处 `dirty` 用 `detail?.config`，`onSave` 却直接读 `detail.config.natural`；撤销授权或刷新后该行消失时，点击保存会抛 `TypeError`。

修法：统一为 `detail?.config?.natural ?? {}`。

### 9. `npm test` 静默漏跑 64 个测试文件（P1，流程缺陷）

`scripts/test.mjs` 用硬编码白名单（71 项 + `app-*.test.mjs`），`tests/` 实际有 133 个套件，**64 个从未在任何 npm script 中执行**（含 `runtime-startup`、`moments-protocol`、`memory-integrity`、`dsh-plugin` 等），而注释只解释了 2 个例外。

修法：新增守卫测试 `tests/test-runner-coverage.test.mjs`，把当前 64 个“已知缺口”显式钉住——新增套件要么接进白名单，要么显式登记，否则测试失败；同时校验白名单里没有指向不存在文件的条目。守卫本身已接入默认套件。

### 附：这批未运行测试里**确实有失败**（已实测）

单独执行 64 个套件（`node --test --test-concurrency=1 tests/<each>`）得到的真实故障：

- `prompt-composition.test.mjs` 大量用例：`TypeError: Cannot read properties of undefined (reading 'listProviders')` / `ctx.llm.listProviders is not a function`（`lib/testing.js` → `runLocalAgent` → `availableModel`）。这是 `AppAgentRunner` 改走 `ModelClient` 之后测试夹具没跟着改。
- `reply-modes.test.mjs:204` 超时：`test timed out after 10000ms`（实际 15.3 s），单条回复排队 80 条消息的用例过慢。
- `source-structure.test.mjs:69`：`Error: Wechat Agent package resources could not be located`（`backend/platform/resources.mjs:13`），需要打包产物。
- `remote-administrators`、`remote-task-status`、`runtime-workspace`：`'test failed'`（夹具与现行为不一致）。

## 三、待修复问题（按严重度，均带证据）

> **状态已更新**：本节列的是第一轮审查时的结论。第二轮已把其中绝大多数改掉并通过全量测试，真实状态见 [第七节](#七第二批修复已验证2026-11-17-晚)。只剩 4 项仍未修，也在第七节末尾列出。

> 以下是审查确认的线索，本轮**未改动**，因为修复面较大或需要产品判断。**标注“已复核”的是我亲自读过代码并确认的；“待复核”的是子代理结论，尚未逐行验证。**

### P0

| # | 问题 | 证据 | 状态 |
|---|---|---|---|
| 1 | 调度器任意一次 tick 异常（Windows 上 `save()` 因 AV/索引占用抛 `STATE_WRITE_FAILED`）会把 `stopped` 永久置真且无自动恢复，全部提醒静默停摆；而 `create()` 不检查 `stopped/error`，用户还能继续创建永不执行的提醒 | `modules/tasks/scheduler.mjs:477-479`、`:287`、`:335` | 待复核 |
| 2 | 发送飞行中被 `cancel()`/`close()` 取消时，`run.state` 无条件写成 `'failed'`，而同文件恢复路径对同一情形写 `'unknown'`；微信可能已发出，用户据此重建任务 → 重复发送 | `modules/tasks/scheduler.mjs:597-603` 对比 `:606-608` | 待复核 |

### P1

| # | 问题 | 证据 | 状态 |
|---|---|---|---|
| 3 | `wechat_file` 工具从未注册到模型工具链：`modules/tools/files.mjs` 只在 `tests/exports.mjs` 被 import，生产代码零引用；但 `prompts/files/tools.json` 仍在发布、提示词仍让模型用它 → 附件读取整体不可达，模型只会回“读不到附件” | `modules/tools/files.mjs:22-25`、`modules/conversation/reply.mjs:195-384`、`modules/agent/local-loop.mjs:19`、`prompts/memory/context.mjs:14` | 已复核（grep 全仓零生产引用） |
| 4 | 上传槽位与 `.part` 临时文件泄漏：`this.uploads` 只在 `finish`/`abort` 里删，扫盘只删 24 h 以上的**文件**、不回收槽位；累计 8 条僵尸上传后 `beginUpload` 恒抛 `ASSET_UPLOAD_BUSY`，只能重启 | `modules/media/library.mjs:641`、`:646-650`、`:729` | 待复核 |
| 5 | 上传完成的 `finally` 清理抛错会覆盖已成功的导入结果（导入其实成功、界面报“上传已取消”） | `modules/media/library.mjs:712-717`、`:727` | 待复核 |
| 6 | 每条消息都把整份长期记忆状态读一遍、深拷贝一遍、整份重写，且 `pending/seen` 无上限 → 写放大 O(N²) | `modules/memory/long-term/store.mjs:394-419`、`:251-253` | 待复核 |
| 7 | 回复路径上按“事实条数”重复读状态文件、按“分区数”重建全部会话列表：`document()` 读 2 次、`parse()` 每条旧事实再读 1 次、每个分区调一次 `conversations()` | `modules/memory/long-term/store.mjs:268`、`:280`、`:373`、`:383` | 待复核 |
| 8 | 会话记忆 `append()` 每条消息全量 parse + stringify + fsync；同一条回复还会再全量 `load()` 4 次 | `modules/memory/conversation/store.mjs:194-201`、`:157`、`backend/storage/atomic-json.ts:13-14`、`modules/conversation/reply.mjs:151/153/165/168` | 待复核（与基线里 50 s/15 s 的两个慢测试同源） |
| 9 | 图片记忆 `needsCapture()` 对**每个附件**做一次 `load()`（全量会话重建 + 祖先 lstat + 整份索引 parse） | `modules/memory/images/store.mjs:371-374`、`:231`、`modules/memory/conversation/store.mjs:401` | 待复核 |
| 10 | 两个后台定时器空闲时反复全量解析所有会话（15 s 窗口扫描 ≈ 4.8 GB/h 空转解析；60 s 图片清理且墓碑永不删除） | `modules/conversation/channel.mjs:84`、`modules/conversation/memory-maintenance.mjs:86-89`、`modules/memory/images/store.mjs:207-208`、`:590-592` | 待复核 |
| 11 | 批量删除事实是 O(k × 文档长度) 的字符串复制，单次最多 5000 条 → 200 万字符文档下约 20 GB memcpy，主线程卡死 | `modules/memory/long-term/store.mjs:648-650`、`:617` | 待复核 |
| 12 | 执行轨迹既无保留期也无清理入口：`this.days` 只增不减，磁盘 `events.jsonl`/`content/*.json` 无上限，`cleanup` 不含 trace 类型 | `modules/traces/store.mjs:84-87`、`:42`、`modules/traces/api.mjs:2`、`modules/cleanup/service.mjs:83` | 待复核 |
| 13 | 已结束的定时任务永不删除，`data.tasks` 无上限；`list()` 对每条任务做一次 `conversations().find()` | `modules/tasks/scheduler.mjs:188-190`、`:448-457` | 待复核 |
| 14 | 安装包下载时校验 sha512，但真正执行前**不再复校**，只检查“存在 + 目录正确”；缓存目录位于可被另一端写入的共享数据根下 | `desktop/updates.cjs:582-584`、`:22-23`、`desktop/main.cjs:121` | 待复核 |
| 15 | 发布门禁是死代码：`scripts/package-resources.mjs` 读 `manifest.files`，但 `package.json` 没有 `files` 字段（白名单在 `electron-builder.json`），任何调用都 `TypeError`；而它只在被排除的测试里被调用，所以“包里不得有账号/密钥”的断言从未执行 | `scripts/package-resources.mjs:9-10`、`tests/package-resources.test.mjs:8` | 待复核 |
| 16 | 每次保存都对每个会话 `JSON.stringify(view)` 做脏判断，并把整份 JSON 再存一份在内存；`config.commit()` 还会重读 `config.yaml` 与全部 prompt 文件 | `backend/storage/state-store.mjs:134-140`、`:117-121`、`backend/config/repository.mjs:126`、`:169` | 待复核 |
| 17 | 打开“数据目录”设置页会在主进程同步递归扫描数据目录**两次**（当前根 + 插件根），页面上是秒级无响应 | `backend/storage/data-root.mjs:127`、`:53-72`、`backend/app/desktop.mjs:51-53` | 待复核 |
| 18 | 外部编辑 `config.yaml` 会连带冻结全部状态持久化：`channel.json` 被塞进同一个配置事务，事务入口先 `assertCurrent()` → 抛 `CONFIG_CHANGED` → `channel.fail()` 停掉所有自动回复 | `backend/storage/state-store.mjs:119-121`、`backend/config/repository.mjs:169-171` | 待复核 |

### P2 / P3（择要点）

- **上传/下载**：`modules/media/library.mjs` 上传分块校验健全，但缺少单账号配额与总超时。
- **交互与点赞的无界增长**：`modules/moments/likes.mjs:81-85` 的 `today()` 对每条动态全量扫描 records 并逐个做时区换算；`modules/moments/interactions.mjs:353-354` 每次提交都做 O(runs × rows) 全表扫描。
- **轨迹索引裸解析**：`modules/traces/store.mjs:87` 用裸 `JSON.parse`，某天索引被截断即整页失败且无修复入口（构造器与 `revoke()` 都有容错，这里没有）。
- **更新并发**：`desktop/updates.cjs:501-510` 的 `downloading` 在 `await check()` **之后**才置位，两个并发调用都能进入；`:454` 的 `latest.sha512 &&` 短路在校验前读可变全局，理论上可跳过校验。
- **UNC 路径**：`desktop/main.cjs:112-114` 的 `wechat-app:open-path` 接受 `\\host\share` 并立刻 `stat`，会向远端 SMB 发起 NTLM 认证。
- **构建可观测性**：`scripts/build.mjs:13` 写死 `sourcemap: false`，线上崩溃只有 `lib/app.js:行号`。
- **许可证目录只增不减**：`scripts/build.mjs:28-29` 缺 license 直接中断构建；`licenses/` 从不清空，旧依赖许可证会被打进包。
- **打包未校验产物**：`scripts/package.mjs:20-22` 不检查 `latest.yml` 与 `*.blockmap` 是否产出，增量更新可能静默失效；`.sha256` 还会写到历史安装包旁边。
- **前端重复轮询**：全前端 23 处周期任务，`status` 2 s 常开 + 页面级 2–5 s，进入“记录”页约 1 RPC/s；**没有任何一处**处理 `document.hidden`（只有 `use-clock.mjs:15` 注册了 `visibilitychange`）。
- **前端重复实现**：`Field` 3 套、`Empty` 2 套、`Button` 2 套、提示 3 套；`frontend/page-content.jsx` 有 12 处各自实现的超时（30 s / 120 s / 300 s），且 `AbortSignal.any([signal, …])` 假设 `signal` 非空。
- **长列表未虚拟化**：`frontend/pages/conversations/authorization-page.jsx:264`、`frontend/pages/memory/long-term-page.jsx:339`（作为对照，媒体库已经做了 24 条/页分页）。
- **记忆脱敏只靠提示词**：`modules/memory/roles/extraction.mjs:175` 把模型写好的脱敏文本替换成逐字引文，而存储层没有任何脱敏实现，真实姓名/手机号会进 `global-memory.md` 并每轮重发给模型。

## 四、优化方向（建议按此顺序推进）

1. **持久化层降本（收益最大）**
   - 用脏标记 + revision 代替 `JSON.stringify` 全量比较（`state-store.mjs:134`），内存里不再存第二份全库 JSON。
   - 会话/长期记忆改为“追加日志 + 定期快照”，把每条消息一次 fsync 改成批量提交；回复路径上把多次 `load()` 合并成一次。
   - `config.commit()` 拆出“只提交 `channel.json`”的路径，`assertCurrent()` 只保护 `config.yaml` 与 prompt 自身（解决 #18 的连锁停机）。
2. **记忆子系统**：`document()` 只读一次状态并作为参数下传；分区名一次性建 `Map`；图片索引别借道配置仓库；`needsCapture` 批量传入 `items/deleted/settings`；墓碑与归档加 TTL/保留策略。
3. **调度与轨迹的失败隔离与保留策略**：单任务异常只标记该任务；连续 N 次失败才停机；终态任务与轨迹加保留期，并给 `cleanup` 增加 `traces` 类型（复用现有的两阶段确认）。
4. **测试体系**：把 `scripts/test.mjs` 改成反向枚举 + 显式排除表（本轮已加守卫防止再漂移）；修复第三节附列的 4 类失败后把对应套件接回默认运行；补一条 CI。
5. **类型与静态检查**：要么新增 `tsconfig.json` + `tsc --noEmit`（`.ts` 文件已有 15 个），要么把它们改成 `.mjs`——现在类型注释没有任何校验价值。
6. **桌面安全**：安装前复校 sha512/size 并 `realpath` 校验父目录，把更新缓存移出共享数据根；`open-path` 拒绝 UNC/`\\?\`。
7. **前端**：给轮询加 `document.hidden` 感知并统一到一个 `usePoll`；`rpc` 层提供 `withTimeout(signal, ms)`；`Field/Empty/Button/Notice` 收敛到单实现；超长列表引入窗口化。

## 五、验证

- 新增回归测试：`tests/storage-recovery.test.mjs`（5 项：锁截断回收、半写锁不被抢占、活锁不被回收、残留 tmp 不阻塞写入、外来文件仍拒绝）、`tests/test-runner-coverage.test.mjs`（2 项：白名单漂移守卫）。
- 第一轮（9 项修复）：`node scripts/build.mjs` 通过，`node scripts/test.mjs` **1052 → 1059 项全部通过**，0 失败。
- 第二轮（第七节的 20 项修复）：`node scripts/build.mjs` 通过，`node scripts/test.mjs` **1059 项全部通过 / 0 失败，耗时 1962.6 s**。
- 第二轮期间出现过一次回归并已修正：`scheduler.create()` 一度在 `stopped` 为真时拒绝创建任务，而 `stopped` 的初值就是 `true`（`backend/app/runtime.mjs:45` 构造后显式置真，只有 `start()` 才复位），导致「撤销授权清理任务」用例失败；改为只在**连续失败导致的停机**（新增 `this.failed` 标志）时拒绝。

## 六、未覆盖范围（如实说明）

- 微信协议层（`backend/wechat/protocol/*.ts`，约 750 行核心文件）只做了抽查，未逐条核对协议字段与回执语义。
- `modules/moments/` 下 20 余个文件（素材、图片、好友评论、发布审阅）只覆盖了发布/点赞/互动主链路。
- `modules/recovery/service.mjs`、`modules/workbench/store.mjs` 只做引用级阅读。
- 未在真实微信账号上做回归（`docs/live-regression.md` 的实机流程本轮未执行）。

## 七、第二批修复（已验证，2026-11-17 晚）

第四节的 1–7 条按此顺序落地；全量测试 1059 项通过。

| # | 问题 | 落地内容 |
|---|---|---|
| 1 | 调度器一次异常永久停机（原 P0 #10） | `scheduler.mjs` 增加 `MAX_SCHEDULER_FAILURES = 5` 与失败计数，单次失败只记错误并继续重试，干净一轮后清零；只有连续失败才置 `stopped`，并用新增的 `failed` 标志拒绝新任务（`stopped` 初值本来就是 true，不能当判据） |
| 2 | 发送中被取消记成 failed（原 P0 #11） | `scheduler.mjs` 的 catch 分支复用恢复路径的 `sendAttempted` 判定：已发出但无回执记 `unknown` 并转 paused；`cancel()` 在 abort 前把在飞 run 标 `unknown` |
| 3 | 终态任务永不删除 + `list()` 逐条查会话（原 P1 #22） | `pruneRuns()` 增加终态任务保留策略（500 条 / 30 天，保留仍有 `runId` 指向的行）；`list()` 改为一次性建 `Map(chatType\0peerId → name)` |
| 4 | 长期记忆每条消息全量读写（原 P1 #15） | `long-term/store.mjs` 按 accountId 缓存已解析状态（mtime+size 失效，命中仍推进保留期与 markdown 引导）；`saveState` 在字节未变时跳过写入；`seen` 裁到 4000 |
| 5 | `document()` 按事实条数重复读盘（原 P1 #16） | `document()` 只取一次 state 并传给 `parse(accountId, markdown, retentionActivatedAt)`；分区名用一次 `conversations()` 建 `Map` |
| 6 | 会话记忆每条消息全量 parse+stringify+fsync（原 P1 #17） | `conversation/store.mjs` 增加按会话键的文档缓存（保存后更新、mtime+size 失效、命中时深克隆）；`snapshot()` 改为切片前先克隆 |
| 7 | 图片记忆每个附件一次 `load()`（原 P1 #18） | `needsCapture(input, entry, attachment, state)` 接受外部传入的 state；`enrich()` 在过滤器外只加载一次 |
| 8 | 15 秒窗口扫描空转（原 P1 #19） | `memory-maintenance.mjs` 用 `WeakMap` 按文档 `revision`/`generation` 记忆 `memoryText(doc).length`，只有文档变化才重算文本；逐 peer 的 `load()` 保留，扫描调用次数断言不变 |
| 9 | 批量删除 O(k×文档长度)（原 P1 #20） | `long-term/store.mjs` 新增 `replaceRanges()` 单趟拼接，替换 `revoke`/`resolveFact`/`deleteFacts`/`extract` 及归档循环共 5 处降序 splice |
| 10 | 轨迹无保留期、无清理入口、索引裸解析（原 P1 #21） | `traces/store.mjs` 新增 14 天 LRU 缓存 + 30 天保留期（每日 `unref()` 定时清扫，三重归属校验后才删）+ `readIndex()` 容错；`list()` 跳过损坏日并返回 `errors`；`cleanup/service.mjs` 新增 `traces` 清理类型（复用两阶段确认） |
| 11 | 安装包执行前不复校哈希（原 P1 #23） | `updates.cjs` 的 `install()` 用 `realpath` 复核父目录并比对缓存里的 sha512/size，不符则删除并抛 `UPDATE_HASH_MISMATCH` |
| 12 | 下载互斥竞态与校验短路（原 P3） | `downloading` 在任何 `await` 之前同步置位；`latest` 快照为局部 `feed` 贯穿整条链路；缺 sha512 视为校验失败并抛 `UPDATE_UNVERIFIED` |
| 13 | 发布门禁是死代码（原 P1 #24） | `package-resources.mjs` 改读 `electron-builder.json` 的 `files` 并真正展开 glob（`prompts/**` 等），`package.mjs` 在 spawn 之前调用它，失败即退出 |
| 14 | 打包不校验产物（原 P3） | `package.mjs` 打包后断言 `latest.yml` 与 `*.blockmap` 存在，并比对版本/大小/base64 sha512；`.sha256` 只写给本次产物 |
| 15 | 每次保存全量序列化做脏判断（原 P1 #25） | `state-store.mjs` 用 `DIRTY`/`fingerprint` 脏标记替代整份 `JSON.stringify`，`written` 改为 `WrittenSnapshots`（干净视图按需重建，语义与 `archive.mjs` 的 `withSourceLocks` 一致） |
| 16 | 外部改 YAML 冻结全部持久化（原 P1 #27） | `repository.commit()` 把 `assertCurrent()` 绑定到"确实要写 config.yaml"，只提交 related 时不再校验；事务日志与原子写未变 |
| 17 | 数据目录页同步全盘扫描（原 P1 #26） | `data-root.mjs` 的 `directorySize()` 加 20000 条目 / 50 ms 上限并返回 `{ bytes, truncated }`，`describeDataRoot()` 透出 `truncated` |
| 18 | 上传槽位与 `.part` 泄漏、finally 覆盖成功（原 P1 #13、#14） | `media/library.mjs` 新增 `reapUploads()`（按 30 分钟淘汰，先删文件**无条件**释放槽位），`beginUpload` 先回收再判 8 条上限；`abortUpload` 的 delete 移入 `finally`；`finishUpload` 的 finally 不再抛出 |
| 19 | `wechat_file` 提示词悬空（原 P1 #12） | 结论修正：该工具**不是漏接**——`backend/wechat/worker.mjs:161` 的 `files` 分支直接抛 `FILE_FEATURE_DISABLED`，附件功能在通道层已停用。故不注册工具，改为删掉 `prompts/memory/context.mjs` 里那行 `tool: 'wechat_file'`（保留"收到但未读"的事实），并在 `modules/tools/files.mjs` 顶部注明未接入的原因 |
| 20 | 前端轮询/超时/告警/长列表（原 P2 多项） | 新增 `frontend/hooks/use-poll.mjs`（隐藏时 5 倍间隔 + `visibilitychange` 立即补跑），接入 `use-panel` 两处与 `use-workbench`；`rpc.mjs` 新增 `withTimeout(signal, ms)`，`page-content.jsx` 8 处收敛；告警条记录失败端点并按端点重试，`processing.fault` 独立渲染；授权页与长期记忆页的行改为 `memo` 组件 |

### 仍未修复（4 项，均为有意保留）

1. **组件 `Field`/`Empty`/`Button` 不合并**：核对后它们不是副本而是适配器（`automation-ui.jsx` 的 Field 用 `label.wa-field` + `span` 结构、`workbench-ui.jsx` 的 Empty/Button 负责默认样式与 `children→description` 映射），re-export 会改变 DOM 与 CSS（`.wa-automation-field` flex 布局、`.wa-assets-field>span:first-child` 等选择器会失效）。要合并必须先改样式，属独立改造。
2. **记忆脱敏**：提示词要求脱敏，但 `modules/memory/roles/extraction.mjs` 会把 `text` 换回逐字引文，存储层没有任何实体替换。这是**产品决策**（要"逐字原话"还是要"不落真实姓名/手机号"），不宜由代码单方面改。
3. **点赞/互动的无界扫描**：`modules/moments/likes.mjs:81-85` 的 `today()` 仍对每条动态全量扫 records，`interactions.mjs:353-354` 每次提交仍做 O(runs×rows) 扫描；两处的 records/runs 也没有保留期。改动涉及配额语义，本轮未动。
4. **未运行的 64 个测试**：本轮只加了守卫（新增套件不会被静默漏跑），没有把它们接回默认套件，也没有修其中的失败（`prompt-composition` 的 `ctx.llm.listProviders`、`reply-modes` 超时、`source-structure` 需要打包产物、`remote-*` 夹具过期）。
