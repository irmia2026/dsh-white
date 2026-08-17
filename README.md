# Dsh-white

> 非官方 DeepSeek Harness 桌面发行版 —— 双击即用的编码 Agent 桌面应用。
> 不用装 Node，不用 npm，不用构建。下载、安装、开聊。

![logo](build-resources/icon.png)

**Dsh-white** 把官方只有浏览器形态的 [`dsh web`](https://github.com/deepseek-ai/deepseek-harness) 封装成 Windows 桌面应用（macOS / Linux 走 CI 构建）：Electron 壳 + sidecar 运行时，**dsh 源码零改动**，跟随上游版本。

## 下载安装

前往 [Releases](https://github.com/irmia2026/dsh-white/releases) 页面：

| 文件 | 说明 |
|---|---|
| `DshWhite-x.y.z-Setup.exe` | 安装版（**支持自动更新**） |
| `DshWhite-x.y.z-Portable.exe` | 便携版（免安装，不支持自动更新与开机自启） |

> ⚠️ 未做代码签名，Windows SmartScreen 会提示"未知发布者"——点"仍要运行"即可。这是非官方社区构建的正常现象。

## 首次使用

1. 启动后自动打开 Web UI（首次启动约 20 秒初始化，之后秒开）
2. 设置 → Models → 填入 DeepSeek API Key（写入 `~/.dsh`，与 CLI 共享）
3. 开聊

## 功能

- **桌面化体验**：托盘常驻、关闭到托盘、开机自启、窗口尺寸/位置记忆、右键菜单、启动画面
- **崩溃自愈**：后端异常退出自动按指数退避重启，状态面板实时展示（阶段/端口/PID/重启次数/运行时长/最近错误）
- **日志面板**：实时流式日志 + 轮转文件，托盘 → "日志与状态" 一键打开
- **自动更新**：启动后自动检查更新，发现新版本由你手动确认下载安装（仅安装版）
- **数据互通**：会话、凭证、配置与官方 CLI 共享 `~/.dsh`——桌面端开的会话，命令行里也能继续
- **轻量**：闭包 123 MiB、安装包 ~129 MB、暖启动 ~1.2s、内存占用为 Electron 应用正常水位

## 从源码构建

前置：[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 仓库根已完成 `pnpm install && pnpm run build`，且本目录（`desktop/`）位于该仓库根下。

```powershell
cd desktop
npm install                    # 本机网络下 pnpm 的 fetch 层不稳；electron 二进制走 npmmirror
node scripts/materialize.mjs   # 物化 dsh 闭包到 .staging/dsh（约 123 MiB）
node scripts/make-icons-from-logo.mjs  # 从 build-resources/logo.png 生成图标
npm run dev                    # 开发运行
```

验证与打包：

```powershell
node scripts/smoke-boot.mjs    # 冒烟：闭包真实启动并服务页面
npm run build:dir              # 未打包目录形态（快速验证）
npm run build:win              # NSIS 安装版 + portable（release/）
```

## 网络注意事项（中国大陆网络实测）

- `registry.npmjs.org` 直连超时 → `.npmrc` 已指向 `registry.npmmirror.com`
- pnpm 的 fetch 层在本网络下会 `UND_ERR_DESTROYED` → 本包使用 npm
- electron 二进制：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后再 `npm install`
- 自动更新从 GitHub Releases 拉取——**网络与签名是用户自己的事**

## 架构

```
Dsh-white.exe (Electron 43, Node 24.18.1)
├── app.asar            壳代码（托盘/面板/设置/更新，几十 KB）
└── resources/dsh/      自包含 dsh 运行时（afterPack 从 .staging 整树拷贝）
    ├── lib/bin.js、config/agent-presets/、LICENSE、THIRD_PARTY_NOTICES.md
    └── node_modules/   427 包扁平闭包（零符号链接，瘦身至 123 MiB）
```

- 主进程自选端口（默认 3080，占用时降级随机）→ `ELECTRON_RUN_AS_NODE` sidecar 跑 `dsh web` → 窗口同源加载 UI
- sidecar 以 `--expose-internals` 启动（dsh loader 的 HMR 需要 Node 内部模块访问）
- 壳设置存 `%APPDATA%\Dsh-white\`，与 dsh 数据域 `~/.dsh` 完全分离

## 已知限制

- **portable 版不支持自动更新与开机自启**
- Windows 上 `tool-bash` 自动禁用（用 pwsh）；需要 bash 的预设需自装 Git Bash/WSL
- Windows 沙箱为策略层（文件边界 + 审批弹窗），无 OS 级隔离
- macOS 未签名（Gatekeeper 需右键打开）；Linux AppImage 可能需 `--no-sandbox`
- 冷启动（首次运行）约 20 秒用于初始化运行时，之后秒开

## 免责声明

Dsh-white 是**非官方社区构建**，与 DeepSeek 无隶属关系。名称 "Dsh-white" 可辨识为 DeepSeek Harness 的衍生品。发布物保留上游 LICENSE 与第三方声明（随安装包分发）。

## 许可

MIT（与上游 deepseek-harness 一致）。
