# 开发指南

本目录是独立的 Windows 桌面应用源码。日常运行和构建不从相邻插件目录加载代码，也不需要 DeepSeek Harness。

## 环境与运行资源

- Windows 10 / 11 x64。
- Node.js 22.18 或更高版本，使用仓库的 `package-lock.json` 安装依赖。
- 准备完整运行包时需要系统 Python 和网络；最终使用者直接安装 Release 中的安装包即可。
- 完整桌面启动需要与项目清单匹配的微信 3.9.12.51 组件。专有二进制不包含在 Git 源码仓库中，组件许可见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

```powershell
git clone https://github.com/Bozheng-Li/Wechat-agent-app.git
cd Wechat-agent-app
npm ci
npm run engine:prepare -- "C:\path\to\wechat-3.9.12.51-components"
npm run runtime:prepare
npm run build
npm start
```

`engine:prepare` 按允许列表复制运行组件并验证关键文件 SHA-256。`runtime:prepare` 准备内置 Python 及固定版本的依赖。只有源码的开发者可先运行 `npm run build` 检查 JavaScript 与前端构建；完整桌面启动和验收需要上述运行资源。

默认数据目录为 `%APPDATA%\dsh-Wechat-app`。开发时可以设置 `WECHAT_APP_HOME` 使用隔离数据；同一 Windows 用户仍受应用共用的单实例锁保护。

## 验证

按顺序执行：

```powershell
npm test
npm run test:desktop
```

业务测试默认并发为 1。桌面验收使用真实 Electron 页面，验证模型设置、密钥加密、重启持久化、单实例、离线后台检查和布局。默认测试使用临时数据及模拟模型、微信传输，不登录真实微信，也不调用付费模型。

本机已有插件模型配置时，可额外运行以下隔离验收：

```powershell
npm run test:live -- --from-plugin
```

这会真实调用配置的模型、搜索与生图 API，可能产生费用。脚本只读取插件的服务配置和密钥，测试资料写入忽略的临时目录；微信消息、联系人、朋友圈和回执均为模拟数据。报告输出到 `artifacts/live-chain-report.json`。此辅助验收不属于独立 App 的运行依赖。

本版本验收范围见 [validation.md](validation.md)。

## 构建安装包

```powershell
npm run pack
npm run audit:package
```

输出位于 `release/`：

- `Wechat-Agent-App-<版本>-Setup.exe`：Windows x64 NSIS 安装包。
- `Wechat-Agent-App-<版本>-Setup.exe.sha256`：安装包 SHA-256。
- `win-unpacked/`：目录版。也可用 `npm run pack:dir` 单独生成目录版。

安装包包含必要运行组件、依赖许可和使用文档；不包含账号数据、模型密钥、测试资料或源码仓库中的开发依赖。包内容审计会核对构建文件、运行时、文档和组件哈希。

Release 对应相同版本的源码标签，安装包作为 Release 附件提供；`release/`、`artifacts/`、账号目录与运行组件二进制均不进入 Git 提交。

## 代码结构

| 目录 | 职责 |
| --- | --- |
| `desktop/` | Electron 窗口、托盘、共用单实例锁、系统代理、受限 IPC 与版本更新下载。 |
| `backend/app/`、`backend/platform/` | 应用生命周期、模型 API、服务配置与 Windows 加密密钥。 |
| `backend/wechat/`、`runtime/` | 微信连接协议及隔离的运行服务。 |
| `modules/`、`shared/`、`prompts/` | 回复、记忆、朋友圈、素材、任务与业务契约。 |
| `frontend/` | React 桌面界面。 |
| `scripts/`、`tests/` | 构建、运行资源准备与验收。 |

数据目录（data root）是账号、配置、记录与记忆的唯一根目录。桌面版把指针存在 `%APPDATA%\dsh-Wechat-app\location.json`，DSH 插件存在 `~/.dsh/wechat-agent/location.json`，两份文件格式一致；把两端指到同一个目录即共用数据。切换以“待执行”方式记录，下次启动前复制并校验，实现见 `backend/storage/data-root.mjs`。

DSH 原生任务、终端、SSH / VS Code 连接和宿主搜索不属于独立版能力。联网搜索由应用自己实现：`modules/search/` 既有 Tavily 协议，也有 DeepSeek 官方 Anthropic 兼容接口（`{baseURL}/messages` + `web_search_20250305` 服务端工具），两者各用独立密钥。桌面宿主通过受限 IPC 向页面开放本应用的管理操作。
