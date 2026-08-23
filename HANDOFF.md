# Dsh-white 打包交接文件

日期：2026-08-14 ｜ 状态：**更名 Dsh-white 完成；瘦身 289→123MiB；UX 批次（固定端口/时间戳/窗口记忆/右键/下载框/启动画面/手动重启）已验证；剩余发布侧工作见文末**

## 目标

官方只发布 `dsh web`（浏览器形态）。本项目把它封装成非官方桌面应用 **Dsh-white**（appId `com.deepharness.desktop`），三平台分发（Windows 先行，macOS/Linux 走 CI），**dsh 现有源码零改动**（便于跟随上游）。

## 架构（已定，勿轻易推翻）

Electron 壳 + sidecar 子进程：

```
Dsh-white.exe (Electron 43, main.mjs)
├── app.asar          仅 electron/ + ui/ + assets/（壳代码，~KB 级）
└── resources/dsh/    自包含 dsh 运行时（afterPack 钩子从 .staging/dsh 拷贝）
    ├── lib/bin.js、config/agent-presets/、package.json（含完整 dependencies）
    └── node_modules/ 427 包扁平闭包（koffi/@koromix、node-pty+conpty、前端 dist）
```

- 主进程自选空闲端口 → `spawn(process.execPath, ['--expose-internals', resources/dsh/lib/bin.js, 'web', '--port', N], { env: { ELECTRON_RUN_AS_NODE: '1' } })`
- **`--expose-internals` 是硬要求**：dsh loader 的 HMR 服务需要 Node 内部模块访问；`node-addon-require-builtin` 垫片在 ELECTRON_RUN_AS_NODE 下不可用（缺 V8 embedder 符号，实测报错），flag 是唯一可靠通道
- BrowserWindow 加载 `http://127.0.0.1:N`（前端与 `/api`、SSE 同源，**前端零改动**）
- 数据共享 `~/.dsh`（与 CLI 的会话/凭证互通；API key 用 Web UI 设置页写入）
- 关窗：先 SIGTERM，2 s 后 Windows `taskkill /T /F` / POSIX SIGKILL

## 功能清单（2026-08-14 完成并验证）

| 功能 | 实现 | 验证 |
|---|---|---|
| 托盘 + 关闭到托盘 + 开机自启 | `electron/tray.mjs` + settings.closeToTray/autoLaunch（`setLoginItemSettings`） | 托盘菜单可操作；关窗隐藏、退出干净 |
| 崩溃自愈 + 状态展示 | `electron/lifecycle.mjs`：指数退避重启（1s→30s）+ 状态对象；面板实时展示 | sidecar 异常退出后自动重启（实测重启循环正常） |
| 日志面板 | `electron/log-store.mjs`（环形 2000 行 + 8MB×3 轮转）+ `ui/panel.html` 两页签面板（状态/日志/设置） | 面板可拉取/流式日志 |
| 自动更新 | `electron/updater.mjs`：启动 30s + 每 4h 自动检查、手动安装；仅 NSIS 安装版；代理形态的网络错误（ERR_CONNECTION_CLOSED 等）自动切直连重试一次（`useDirectConnection` → `setProxy({mode:'direct'})`） | latest.yml/blockmap 已随构建产出；发布后即可生效。已实测：本机系统代理（Clash 7897）会掐断 github.com 的 TLS，直连正常 → 兜底有效场景确认 |

~~提示音系统~~（2026-08-17 移除）：隐藏 WebAudio 窗口的播放链路在 sandboxed/无手势环境下可靠性不达标，用户决定移除。若未来需要，优先用 Electron `Notification`（系统通知音）而非隐藏窗口方案。

## 已验证事实（省得重测）

| 项 | 结论 |
|---|---|
| Electron 43.4.0 捆绑 Node | 24.18.1，满足 dsh engines `^22.19 \|\| >=24` |
| `node:sqlite`（Electron Node 下） | 可用 |
| node-pty / koffi 原生件 | N-API/平台包，Electron 下直接加载，无需 rebuild |
| 物化闭包 | resolver-walk（见下），427 包 / ~290 MiB / 零符号链接 |
| 闭包真实启动 | `ELECTRON_RUN_AS_NODE` + `--expose-internals`：冷启 ~14s、暖启 ~4s，页面 200 且带 `__DSH_BOOT__` |
| 打包 exe | 4s 就绪、sidecar 存活、退出零残留进程 |
| 安装包 | NSIS 161.9MB + portable 161.7MB + latest.yml + blockmap |

## materialize 物化脚本（resolver-walk 版）踩过的坑

1. **optionalDependencies 必须遍历**：koffi 原生库（`@koromix/koffi-<os>-<arch>`）、loader 垫片（`node-addon-require-builtin-<os>-<arch>-msvc`）都在 optionalDependencies；按 `包含 -<platform>-<arch>` 过滤（`endsWith` 会漏掉 `-msvc` 后缀）
2. **包内嵌套 node_modules 必须剔除**：pnpm 的 per-instance 符号链接（cordis ↔ cordis-plugin-include 循环）在 dereference 时 ELOOP；剔除后靠扁平树 + 冲突嵌套解析，并断言 staged 树零链接
3. **staged package.json 必须带完整 dependencies**：`healProfilesModuleFallback` 从安装锚点声明的依赖建 `$DSH_HOME/profiles/node_modules` 链接；缺了它 profile 里所有裸包名导入都 ERR_MODULE_NOT_FOUND
4. **electron-builder extraResources 不可用于闭包**：其文件匹配器默认排除 node_modules（实测只拷进 17 个文件）；改用 `afterPack` 钩子（`scripts/after-pack.cjs`）原生 fs 整树拷贝

## 包管理（2026-08-14 从 pnpm 切到 npm）

- 原因：本网络 pnpm fetch 层必挂（`UND_ERR_DESTROYED`），npm 正常；`registry.npmjs.org` 直连超时 → `.npmrc` 指 npmmirror
- electron 二进制：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`（或手动 `node node_modules/electron/install.js`）
- `pnpm-lock.yaml`/`pnpm-workspace.yaml` 已删除，改 `package-lock.json`

## 常用命令

```powershell
cd desktop（harness 仓库根下的 desktop 目录）
node scripts/materialize.mjs    # 物化（前置：仓库根 pnpm install && pnpm run build）
node scripts/make-icon.mjs      # 占位图标
node scripts/smoke-boot.mjs     # 冒烟：闭包真实启动 + 页面探测
npm run dev                     # 开发运行
npm run build:dir               # 未打包形态（快速验证）
npm run build:win               # NSIS + portable
```

## 调试备忘

- sidecar 日志：`%APPDATA%\Dsh-white\dsh-web.log`（stdout+stderr 合并，自动轮转）
- 应用设置：`%APPDATA%\Dsh-white\settings.json`
- 面板：托盘 → 日志与状态（状态 / 日志 / 设置 三页签）
- 本机对照：仓库根 `pnpm dsh web` 冷启动 ~8.3 s（tsx 源码方式）、RSS ~140–210 MB

## 剩余工作（发布侧）

- [ ] `.github/workflows/desktop-release.yml` 三平台矩阵（tag `desktop-v*` 触发：materialize → 打包 → GitHub Release）；现支持 `workflow_call`（version/upstream_ref/desktop_ref 入参），被 upstream-watch 自动调起；首次 green run 即验收
- [ ] 正式图标（当前为 make-icon 占位）；Windows 代码签名（SmartScreen）；macOS 公证
- [ ] 推送仓库到 `irmia2026/deepharness-desktop`（publish.owner/repo 已占位）
- [x] 上游 dsh 版本漂移策略（2026-08-23 落地）：`.github/workflows/upstream-watch.yml` 每 6h（cron `23 */6 * * *`）+ 手动触发，轮询 `deepseek-ai/deepseek-harness` 最新 release tag 与 `.upstream-tag` 对比；有新版本即 bump desktop patch 版本、提交 main，并 `workflow_call` 调起 desktop-release 按该上游 tag 精确构建发版。**版本号独立递增、不镜像上游 rc 号**——`0.1.0-rc.N` 在 semver 里低于已安装的 `0.1.0`，镜像会导致 electron-updater 永远认为无更新。构建源为官方上游仓库（用户决定，不带 fork 特性分支）

## 文件清单

```
desktop/package.json            独立包（npm 管理；electron-updater 依赖）
desktop/electron/main.mjs       主进程：单实例/选端口/spawn(--expose-internals)/日志/自愈/托盘/更新
desktop/electron/lifecycle.mjs  sidecar 生命周期：指数退避重启 + 状态机
desktop/electron/settings.mjs   应用设置（userData/settings.json）
desktop/electron/log-store.mjs  环形缓冲 + 轮转日志
desktop/electron/updater.mjs    electron-updater：检查自动、安装手动（无 app-update.yml 时跳过，不刷日志）
desktop/electron/tray.mjs       托盘菜单
desktop/electron/preload.cjs    共享 preload（CJS，sandbox 安全）：状态/日志/设置/更新 IPC
desktop/ui/panel.html|mjs       状态/日志/设置面板
desktop/scripts/materialize.mjs 解析器漫游物化 + 完整性校验 + 零链接断言
desktop/scripts/after-pack.cjs  electron-builder afterPack：整树拷贝闭包
desktop/scripts/smoke-boot.mjs  启动冒烟（ELECTRON_RUN_AS_NODE 真实启动 + 页面探测）
desktop/scripts/make-icon.mjs   占位图标（build-resources/* + assets/tray.png）
desktop/electron-builder.yml    files/publish(afterPack 拷贝闭包)
desktop/assets/tray.png          托盘图标
<harness 仓库根>                 未改动任何现有文件
```
