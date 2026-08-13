# DeepHarness Desktop

非官方 DeepSeek Harness 桌面发行版：Electron 壳 + sidecar dsh 运行时，把浏览器形态的 `dsh web` 封装为三平台桌面应用（Windows 先行）。

## 功能

- **Electron 壳 + sidecar**：主进程自选空闲端口，`ELECTRON_RUN_AS_NODE` 子进程跑 `dsh web`，窗口同源加载 UI；dsh 源码零改动，跟随上游
- **托盘常驻**：关闭窗口 = 隐藏到托盘（可关）；托盘菜单：显示/隐藏、日志与状态、开机自启、检查更新、退出
- **崩溃自愈**：sidecar 异常退出自动按指数退避重启（1s→30s），状态面板实时展示（阶段/端口/PID/重启次数/运行时长/最近错误）
- **日志面板**：内存环形缓冲 + 轮转文件（8MB×3），面板内实时流式日志
- **提示音系统**：就绪/任务完成/警告等事件提示音（WebAudio 合成，零音频资产）；事件来自 `/api/events.mux`（preload 同源监听，不改 dsh 一行代码）；开关与音量在设置中调整
- **自动更新**：启动 30s 后自动检查、每 4 小时复查，**发现新版本由用户手动确认下载与安装**（仅安装版；portable 请下载新包）
- **数据互通**：会话/凭证与 CLI 共享 `~/.dsh`；API key 在 Web UI 设置页填写

## 快速开始

前置：仓库根 `D:\DSH` 已完成 `pnpm install && pnpm run build`（闭包从 workspace 的已构建产物物化）。

```powershell
cd D:\DSH\desktop
npm install          # 本机网络下 pnpm 的 fetch 层不稳；electron 二进制走 npmmirror
node scripts/materialize.mjs   # 物化 dsh 闭包到 .staging/dsh（约 290 MiB）
node scripts/make-icon.mjs     # 占位图标（assets/tray.png + build-resources/*）
npm run dev          # 开发运行（窗口 + sidecar）
```

验证与打包：

```powershell
node scripts/smoke-boot.mjs    # 冒烟：闭包在 ELECTRON_RUN_AS_NODE 下真实启动并服务页面
npm run build:dir              # 未打包目录形态（快速验证）
npm run build:win              # NSIS 安装版 + portable（release/）
```

## 网络注意事项（中国大陆网络实测）

- `registry.npmjs.org` 直连超时 → `.npmrc` 已指向 `registry.npmmirror.com`
- pnpm 的 fetch 层在本网络下会 `UND_ERR_DESTROYED` → 本包使用 npm
- electron 二进制：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后再 `npm install`（或手动 `node node_modules/electron/install.js`）
- 自动更新默认从 GitHub Releases 拉取——**网络与签名都是用户自己的事**：Windows 未签名安装包会触发 SmartScreen，README 无法替你绕过

## 架构

```
DeepHarness Desktop.exe (Electron 43, Node 24.18.1)
├── app.asar            electron/ + ui/ + assets/（几十 KB 壳代码）
└── resources/dsh/      自包含 dsh 运行时（afterPack 钩子从 .staging 拷贝）
    ├── lib/bin.js、config/agent-presets/、package.json（含完整 dependencies）
    └── node_modules/   427 包扁平闭包（koffi/@koromix、node-pty+conpty、前端 dist）
```

关键点：

- sidecar 以 `--expose-internals` 启动：dsh loader 的 HMR 需要 Node 内部模块访问，`node-addon-require-builtin` 垫片在 ELECTRON_RUN_AS_NODE 下不可用（缺 V8 embedder 符号），flag 是唯一可靠通道
- 应用设置存 `userData/settings.json`（`%APPDATA%\DeepHarness Desktop\`），与 `~/.dsh` 数据域分离
- 日志：`%APPDATA%\DeepHarness Desktop\dsh-web.log`（sidecar stdout+stderr 合并）

## 已知限制

- **portable 版不支持自动更新**（electron-updater 仅支持 NSIS 安装版）；portable 也不支持开机自启
- Windows 上 `tool-bash` 自动禁用（只有 pwsh）；需要 bash 的预设（如极简模式的 persistent-bash）需用户自装 Git Bash/WSL
- Windows 沙箱为策略层（in-process 文件边界 + 审批弹窗），无 OS 级隔离；Linux 用 landlock/bwrap，macOS 用 sandbox-exec
- macOS 未签名（Gatekeeper 需右键打开）；Linux AppImage 可能需 `--no-sandbox`
- 未做代码签名与公证（SmartScreen/Gatekeeper 提示属预期）

## 发布

1. `npm run build:win` 产出 `release/DeepHarnessDesktop-<ver>-Setup.exe` + `latest.yml` + `Portable.exe`
2. 推送到 `irmia2026/deepharness-desktop` 的 GitHub Release（tag `desktop-v<ver>`），自动更新即生效
3. 三平台 CI 矩阵：`.github/workflows/desktop-release.yml`（tag 触发）

## 许可

MIT。非官方发行：名称 DeepHarness 可辨识为 DeepSeek Harness 的衍生品，发布物需保留上游 LICENSE 与第三方声明。
