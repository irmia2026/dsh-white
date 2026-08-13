# DeepHarness Desktop 打包交接文件

日期：2026-08-14 ｜ 状态：**物化脚本重写后待验证**，其余链路已跑通

## 目标

官方只发布 `dsh web`（浏览器形态）。本项目把它封装成非官方桌面应用 **DeepHarness Desktop**（appId `com.deepharness.desktop`），三平台分发（Windows 先行，macOS/Linux 走 CI），**dsh 现有源码零改动**（便于跟随上游）。

## 架构（已定，勿轻易推翻）

Electron 壳 + sidecar 子进程：

```
DeepHarness Desktop.exe (Electron 43, main.mjs)
├── app.asar          仅 electron/main.mjs（几十 KB）
└── resources/dsh/    自包含 dsh 运行时（materialize 产物）
    ├── lib/bin.js、config/agent-presets/、package.json
    └── node_modules/ 闭包（含 koffi、node-pty、前端 dist）
```

- 主进程自选空闲端口 → `spawn(process.execPath, [resources/dsh/lib/bin.js, 'web', '--port', N], { env: { ELECTRON_RUN_AS_NODE: '1' } })`
- BrowserWindow 加载 `http://127.0.0.1:N`（前端与 `/api`、SSE 同源，**前端零改动**）
- 数据共享 `~/.dsh`（与 CLI 的会话/凭证互通；API key 用 Web UI 设置页，写入 `~/.dsh/.env`）
- 关窗：先 SIGTERM，2 s 后 Windows `taskkill /T /F` / POSIX SIGKILL
- 备选降级：若 Electron 捆绑 Node 出问题，改为 resources 内置官方 Node 22 zip（行为与 CLI 完全同构）

### 为什么是 Electron 而不是 Tauri/Wails

dsh 整体是 Node 产品，分发包必须内置 Node 运行时 + node_modules 闭包（~270 MiB，与壳无关）。Electron 自带 Node，`ELECTRON_RUN_AS_NODE` 让同一个 exe 兼当子进程 node；Tauri/Wails 仍需 sidecar 塞 Node，只省下 Chromium 部分，却引入 WebView 碎片化 + 额外工具链。详见 git 历史中的讨论记录。

## 已验证事实（省得重测）

| 项 | 结论 |
|---|---|
| Electron 43.4.0 捆绑 Node | 24.18.1，满足 dsh engines `^22.19 \|\| >=24` |
| `node:sqlite`（Electron Node 下） | 可用（storage/session 的 sqlite 后端靠它，无 better-sqlite3） |
| node-pty | prebuilds 按平台目录分发（N-API），win 需 `build/Release/conpty/{conpty.dll,OpenConsole.exe}`（postinstall 产物） |
| koffi | install 脚本 `node cnoke.cjs -P . -D src/koffi --prebuild --release` 落 `build/` 原生库；workspace 根安装已含产物 |
| spawn 链路 | 子进程成功启动、绑定动态端口、日志落 `%APPDATA%\DeepHarness Desktop\dsh-web.log`（注意 userData 目录名是 productName） |
| `dsh web --port N` | web profile 官方 flag（packages/bundle/web-app/src/startup.ts） |
| pnpm deploy（legacy） | **不可用**：`overrides: link:vendor/*` 的包（cosmokit/schemastery）整个丢失，.pnpm 实例嵌套依赖为空 |
| pnpm deploy（inject-workspace-packages） | **不可用**：pnpm 自报 shared-lockfile 警告、注入包构建脚本被拒（koffi 缺原生产物）、peer 不装 |

## 当前唯一卡点：运行时物化

`desktop/scripts/materialize.mjs` 已弃用 pnpm deploy，改为**解析器漫游**：用 `createRequire` 沿 workspace 自身 node_modules 链接走 `@deepseek-ai/dsh` 的 dependencies + peerDependencies 闭包，每个包实例 realpath 后整目录拷贝到扁平 `node_modules`（天然继承 workspace 里已构建的原生产物）。

已修复的坑：
1. 无 exports main 的包（`@earendil-works/pi-ai`）→ 三级降级：`<pkg>/package.json` → 主入口向上攀升 → node_modules 手动向上查找
2. 可选 peer（bufferutil、utf-8-validate、hono、ajv、express 等）不在 workspace → 仅 peerDependencies 声明则 warn 跳过
3. peer 依赖随 traversal 自然纳入（不再需要旧版 heal 循环，该逻辑已删）

**最后一次修复后尚未重新运行验证**——这是接手第一件事。

## 接手步骤

```powershell
cd D:\DSH\desktop

# 1. 物化闭包（会先清空 .staging；前置条件：仓库根已 pnpm install + pnpm run build，已完成）
node scripts/materialize.mjs
#    通过标准：输出 "dsh 0.1.0-rc.5 staged (N packages, files, MiB)"，且 --version / web --dump-config 冒烟通过

# 2. 图标占位（electron-builder 用；正式发布前换真 icon）
node scripts/make-icon.mjs

# 3. dev 联调（主进程 spawn + 窗口加载 UI）
pnpm dev
#    通过标准：窗口打开 dsh UI；stdout 出现 "[deepharness-desktop] dsh web ready at ..."

# 4. 打包（先 dir 冒烟，再 NSIS + portable）
pnpm run build:dir
pnpm run build:win
#    产物在 desktop/release/；安装版与 portable 版都要冒烟：UI 可用 + 关窗后无残留 electron/node 进程

# 5. 未做：.github/workflows/desktop-release.yml 三平台矩阵（tag desktop-v* 触发）+ README 定稿
```

## 验证清单（每步的 fail-loud 点）

- [ ] materialize：staging 内 `lib/bin.js`、`config/agent-presets`、`node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html`、koffi `build/`、node-pty conpty（脚本自带检查）
- [ ] dev 运行：UI 渲染、能建会话；**触发一次工具调用**（验证 koffi/node-pty/conpty 在 resources 下存活）
- [ ] API key：UI 设置页填写后写入 `%USERPROFILE%\.dsh\.env`
- [ ] 端口冲突：预先占用 3080 再启动应正常（自选端口）
- [ ] 打包产物退出清理：`Get-Process | ? ProcessName -match "electron|node"` 无残留

## 已知风险（继承自计划）

| # | 风险 | 缓解 |
|---|---|---|
| R1 | Electron 捆绑 Node 与上游 engines 漂移 | 升级 Electron 后先 `ELECTRON_RUN_AS_NODE electron.exe -p process.versions.node` 核实；不满足改内置 Node zip |
| R2 | Windows 强杀子进程可能丢最后一个持久化批窗口的会话事件 | 先 SIGTERM 宽限再杀；dsh 批窗口有界，损失上限小，README 注明 |
| R3 | 非官方分发商标风险 | 名称 DeepHarness 可辨识为衍生；README/关于页注明 unofficial |
| R4 | 上游 0.1.0-rc.x 快速迭代，闭包漂移 | 出包前必须 root `pnpm install && pnpm run build`；manifest 记录版本 |
| R5 | macOS 未签名 Gatekeeper / Linux AppImage `--no-sandbox` | README 写清绕过步骤 |

## 文件清单

```
desktop/package.json            独立包（不进 workspace；pnpm install --ignore-workspace 安装，electron 二进制经 npmmirror 手动跑过 install.js）
desktop/electron/main.mjs       主进程：单实例/选端口/spawn/日志/清理，含诊断 console 输出
desktop/electron-builder.yml    appId/productName、extraResources(.staging/dsh→resources/dsh)、win=nsis+portable、mac=dmg+zip(identity:null)、linux=AppImage+deb
desktop/scripts/materialize.mjs 解析器漫游物化 + 完整性校验 + manifest
desktop/scripts/make-icon.mjs   无依赖生成 icon.png(512)/icon.ico(PNG-in-ICO 256) 占位图标
desktop/.gitignore              node_modules/ .staging/ release/
desktop/.staging/dsh.test/      废弃 deploy 实验残留，可直接删
D:\DSH（仓库根）                 未改动任何现有文件
```

调试备忘：
- 子进程日志：`%APPDATA%\DeepHarness Desktop\dsh-web.log`（stdout+stderr 合并）
- Electron 主进程 stdout：dev 用 `Start-Process -RedirectStandardOutput` 捕获，或终端直接 `pnpm dev`
- 本机曾跑通的对照：仓库根 `pnpm dsh web` 冷启动 ~8.3 s（tsx 源码方式）、RSS ~140–210 MB
