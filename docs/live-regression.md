# 实机回归记录

这份文档记录**在真实微信账号上**跑过的功能回归，和 `tests/` 里那些隔离测试的口径不同：隔离测试证明代码路径正确，这份证明这台机器、这个账号、这两个上游服务真的能用。

## 怎么跑

`tests/live-regression.cjs` 是一个 Electron 主进程脚本，它会用 `runDesktop({ dataHome })` 启动一个真实的应用实例，通过 `application.call(endpoint, payload)` 逐项调用 RPC，最后把结果写进 `artifacts/live/report.json` 和 `report.md`，并顺带截 8 张页面图。

```powershell
# 只读项（不改任何数据）
node_modules\electron\dist\electron.exe tests\live-regression.cjs

# 加上可逆写入：定时任务新建后取消、素材导入后删除、朋友圈草稿生成后放弃
$env:LIVE_ALLOW_WRITES='1'; node_modules\electron\dist\electron.exe tests\live-regression.cjs

# 再加上朋友圈发布/点赞/评论（发布后会立即删除；点赞与评论无法撤销）
$env:LIVE_MOMENTS='1'; $env:LIVE_MOMENTS_IRREVERSIBLE='1'; node_modules\electron\dist\electron.exe tests\live-regression.cjs
```

跑之前必须从托盘 **退出并停止微信助手**：应用是单实例的，另一个实例正在运行时会直接返回 `null`。

它刻意不做这些事：不发聊天消息、不断开账号、不改数据目录、不改模型与人设配置、不删素材库里已有的素材。定时任务定在 6 小时后且不带任何接收人，取消后列表要回到原样才算通过。

## 2026-11-13 · 0.1.7-preview.1

环境：Windows 10 19045，真实登录账号，29 个已授权会话（23 个私聊 + 6 个群），素材库 152 项，长期记忆约 10.8 万字，生图配置两家接口。

| 范围 | 结果 | 说明 |
| --- | --- | --- |
| 运行状态 / 版本 / 登录态 | 通过 | `online=true`、`login=online`、`runtimeReady=true` |
| 模型服务与模型目录 | 通过 | 1 个服务、1 个模型、默认模型已设置 |
| 更新日志、身份文件 | 通过 | 3.3 KB 更新日志、776 字身份文件 |
| 联系人、管理员候选 | 通过 | 174 个联系人、172 个候选用户 |
| 会话记录分页 | 通过 | 单会话记录可读、分页字段完整 |
| 会话记忆索引 / 长期记忆 / 角色卡 / 图片记忆 | 通过 | 29 个会话记忆、11 个长期记忆分区、10 张角色卡 |
| 素材库 | 通过 | 列表、导入、改名、删除全链路，删除后复查回原数量 |
| 定时任务 | 通过 | 新建（+6h、无接收人）→ 出现在列表 → 取消 → 列表回原样 |
| 朋友圈读取 / 扫描 | 通过 | 时间线读取 2 条可见动态，扫描缓存 24 条 |
| 朋友圈草稿 | 通过 | 生成 → 编辑 → 放弃，未留下待发布草稿 |
| 朋友圈发布 | 通过（有告警） | 帖子确实发出并在自己主页可见，删除后复查消失；回执校验报了 `ERR_MOMENTS_WRITE_PROTOCOL`，见下文 |
| 朋友圈点赞 / 评论 | 通过（不可撤销） | 点赞回执 `liked=true`，评论回执带 `commentId`，复查对方动态确认点赞与评论都在 |
| 数据目录 | 通过 | 与 DSH 插件指向同一目录，可读，无未完成的切换 |
| 清理预览 | 通过 | 8 类范围全部可预览，73 行候选、5 行受保护 |
| 生图配置 | 通过 | 两家接口、默认接口已选、凭据可读 |
| 生图出图 | 通过（换分组后） | 0809 换分组后 `gpt-image-2.6-flare` 实测出图：41 秒、1.06 MB PNG、1536×1024，素材生成 → 取图 → 删除全链路通过 |
| 页面渲染 | 通过 | 概览、记忆库、朋友圈、素材、定时任务、模型 / 图片生成 / 数据目录设置共 8 张截图 |

## 三项发现

### 1. 生图密钥在换 userData 之后读不出来（已修）

现象：`status.imageGeneration.credentialConfigured=true`，但真正调用时返回 `IMAGE_GENERATION_CREDENTIAL：本地应用无法读取生图密钥，请检查凭据服务`。

原因：密钥文件用 Electron `safeStorage` 加密，而 Chromium 的加密主密钥按 `userData` 目录各存一份。旧密钥是在 `<userData=…\AppData\Roaming\dsh-Wechat-app>` 下写的，应用实际用的是 `<数据目录>`，两边的主密钥不同，DPAPI 解不开。

修复：在 **设置 → 图片生成** 里把接口密钥重新保存一次（走应用自己的加密上下文）。重新保存后同一个调用返回的错误从「读不到密钥」变成上游 `HTTP 503`，说明读取链路已经通。

> 这个坑值得写进 README 的 FAQ：换电脑、换 Windows 用户、换数据目录之后，密钥都要重填一次。

### 2. 朋友圈发布成功，但回执校验会报错（未改代码）

现象：`moments.write` 发布纯文字动态，约 60 秒后返回

```
ERR_MOMENTS_WRITE_PROTOCOL：微信已返回这条动态，但回执未包含全部指定屏蔽对象；未自动重发
```

但帖子确实发出去了（`moments.read` 在自己主页能按正文找到），继续执行删除也成功（`deleted=true`，复查消失）。

判断：`modules/moments/service.mjs` 的发布回执校验要求微信把「屏蔽对象」原样回显，PC 端这次没回显。应用选择报错而不是当成成功，是为了避免「可见范围没生效却告诉用户成功了」；副作用是界面会显示失败，用户重试就可能发重复。

建议（未实施）：回执缺字段时不要直接判失败，而是按正文回读一次自己的主页确认帖子存在，返回「已发布，可见范围未确认」并带上动态编号，界面据此提供「删除这条」；至少不要静默失败。

### 3. 生图 503：换分组后已恢复

当时的记录：两家配置的接口都返回 `503 model_not_found`，`gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`、`gpt-image-1` 全部无可用渠道，`curl` 直连同样复现，说明是服务商分组里没有可用渠道，不是模型名写错。

后续：账号换分组后 `gpt-image-2.6-flare` 可用，应用里把 0809 的模型列表收敛为这一个模型、设为默认，真机跑通「生成 → 取图 → 删除素材」：41 秒返回 1.06 MB PNG（1536×1024）。应用对失败的处理本来就是对的——返回 `IMAGE_GENERATION_HTTP：0809 / <模型>：生图 API 返回 HTTP 503`，不假装成功、不卡住对话。

## 后续两轮（同一天）

回归之后又针对发现的问题改了两处，都做了实机验证：

| 改动 | 验证方式 | 结果 |
| --- | --- | --- |
| 朋友圈可见范围可配（`publishScope`，默认「自定义屏蔽名单」） | 真实账号发布纯文字动态、不选屏蔽对象 | 1.5 秒拿到回执，`blocked=0`，正文可见，删除后复查消失；不再出现「回执未包含全部指定屏蔽对象」 |
| 生图换模型 | 应用内 `moments.materials.generate` → 取图 → 删除素材 | `gpt-image-2.6-flare` 41 秒返回 1.06 MB PNG（1536×1024），Pillow 可正常解码 |
| 增量更新（`.blockmap` 逐块比对） | 对比两个安装包的 blockmap，并对 release 资源发 Range 请求 | 复用 11868/11909 块，需下载 0.88 MB（整包 238.8 MB）；GitHub 返回 206 与精确字节数 |

### 复跑注意（踩过的坑）

后台 shell 可能还留着上一次导出的变量。第二轮我只想跑只读项，却没有在子进程里彻底清掉 `LIVE_ALLOW_WRITES` / `LIVE_MOMENTS` / `LIVE_MOMENTS_IRREVERSIBLE`，脚本又把点赞和评论跑了一遍——这两样**撤不回来**，只能在手机上手动删。现在复跑前请显式置空再启动：

```powershell
$env:LIVE_ALLOW_WRITES=''; $env:LIVE_MOMENTS=''; $env:LIVE_MOMENTS_IRREVERSIBLE=''
node_modules\electron\dist\electron.exe tests\live-regression.cjs
```

写入门槛是按环境变量判定的（`process.env.X === '1'`），置空即可关闭，不需要删变量。
## 没覆盖到的部分

- **聊天收发、群聊简报、联网搜索**：需要真人发消息触发，本轮没有向任何联系人发消息；聊天链路由 961 项隔离测试与用户本人手工验证覆盖。
- **更新检查与安装**：走主进程 IPC，不在 RPC 里，避免在测试中触发真实下载。
- **清理执行**：只跑了 `cleanup.preview`，没有真正删除任何历史数据。
- **素材理解（assets.describe）**：会在真实素材上重写说明，默认跳过，需要 `LIVE_ASSETS_DESCRIBE=1` 才跑。

## 截图

`artifacts/live/*.png` 是这个脚本拍的页面图，拍摄前会抹掉盘符路径、`wxid_*` 并模糊头像与图片。这些图只在本机留档，不随仓库发布（界面里仍有账号昵称与好友备注，不适合公开引用）。
