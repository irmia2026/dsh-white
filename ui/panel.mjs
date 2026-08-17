// Panel logic: status / logs / settings tabs. Uses window.deepharness from
// the shared preload. Plain DOM, no framework.
const api = window.deepharness

// Hard fail-loud if the preload bridge is missing: a silent `undefined` here
// previously killed the whole panel with no visible symptom.
if (api === undefined) {
  const banner = document.createElement('div')
  banner.style.cssText = 'background:#3a2020;color:#e05656;padding:14px;font:13px/1.5 monospace'
  banner.textContent = 'preload bridge (window.deepharness) 不可用——面板无法与主进程通信'
  document.body.prepend(banner)
}

const $ = (id) => document.getElementById(id)

if (api !== undefined) {
// ── tabs ───────────────────────────────────────────────────────────────────
for (const button of document.querySelectorAll('header button')) {
  button.addEventListener('click', () => {
    for (const b of document.querySelectorAll('header button')) b.classList.remove('active')
    for (const s of document.querySelectorAll('section')) s.classList.remove('active')
    button.classList.add('active')
    $(`tab-${button.dataset.tab}`).classList.add('active')
    if (button.dataset.tab === 'log') scrollLogToEnd()
  })
}

// ── status ─────────────────────────────────────────────────────────────────
const PHASE_LABEL = {
  idle: '空闲', starting: '启动中', ready: '运行中',
  restarting: '重启中（自愈）', failed: '失败', stopping: '停止中',
}

let status = null
let lastTick = Date.now()

function renderStatus(next) {
  status = next
  const phaseEl = $('phase')
  phaseEl.className = `badge ${next.phase}`
  phaseEl.textContent = PHASE_LABEL[next.phase] ?? next.phase
  $('port').textContent = next.port ?? '—'
  $('pid').textContent = next.pid ?? '—'
  $('restarts').textContent = String(next.restarts)
  $('last-error').textContent = next.lastError ?? '—'
  if (next.readyAt) {
    lastTick = new Date(next.readyAt).getTime()
  } else if (next.startedAt) {
    lastTick = new Date(next.startedAt).getTime()
  }
  $('uptime').textContent = next.phase === 'ready' && next.readyAt
    ? formatUptime(Date.now() - new Date(next.readyAt).getTime())
    : '—'
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`
}

setInterval(() => {
  if (status?.phase === 'ready' && status.readyAt) {
    $('uptime').textContent = formatUptime(Date.now() - new Date(status.readyAt).getTime())
  }
}, 1000)

api.getStatus().then(renderStatus).catch(() => {})
api.onStatus(renderStatus)

// ── logs ───────────────────────────────────────────────────────────────────
const logEl = $('log')
let autoScroll = true
let lineCount = 0

function logLine(line, dim = false, error = false) {
  const div = document.createElement('div')
  if (dim) div.className = 'dim'
  if (error) div.className = 'err'
  div.textContent = line
  logEl.appendChild(div)
  lineCount += 1
  while (logEl.childElementCount > 1500) logEl.removeChild(logEl.firstChild)
  $('log-count').textContent = `${lineCount} 行`
  if (autoScroll) scrollLogToEnd()
}

function scrollLogToEnd() {
  logEl.scrollTop = logEl.scrollHeight
}

api.getLogs().then((lines) => {
  logEl.innerHTML = ''
  lineCount = 0
  for (const line of lines) logLine(line, true)
}).catch(() => {})

api.onLog((line) => logLine(line))

$('btn-clear-log').addEventListener('click', () => {
  logEl.innerHTML = ''
  lineCount = 0
  $('log-count').textContent = '0 行'
})
$('btn-scroll-log').addEventListener('click', () => {
  autoScroll = !autoScroll
  $('btn-scroll-log').textContent = autoScroll ? '跟随最新' : '已暂停跟随'
  if (autoScroll) scrollLogToEnd()
})

// ── settings ───────────────────────────────────────────────────────────────
let settings = null

function renderSettings(next) {
  settings = next
  $('set-close-to-tray').checked = next.closeToTray
  $('set-auto-launch').checked = next.autoLaunch
}

const bindToggle = (id, path) => {
  $(id).addEventListener('change', (event) => {
    const patch = path.reduce((acc, key, index) => {
      if (index === path.length - 1) {
        acc[key] = event.target.checked
        return acc
      }
      const next = {}
      acc[key] = next
      return next
    }, {})
    api.setSettings(patch)
  })
}

bindToggle('set-close-to-tray', ['closeToTray'])
bindToggle('set-auto-launch', ['autoLaunch'])

api.getSettings().then(renderSettings).catch(() => {})
api.onSettings(renderSettings)

// ── updater ────────────────────────────────────────────────────────────────
const UPDATE_LABEL = {
  idle: '尚未检查', checking: '正在检查更新…', none: '当前已是最新版本',
  disabled: '此构建不支持自动更新（便携版/开发模式）',
}

function renderUpdate(state) {
  const line = $('update-state')
  if (state.phase === 'available' || state.phase === 'downloaded') {
    line.innerHTML = `发现新版本 <b>v${state.version}</b>（当前 v${state.current}）`
    $('btn-download-update').style.display = state.phase === 'available' ? '' : 'none'
    $('btn-install-update').style.display = state.phase === 'downloaded' ? '' : 'none'
  } else if (state.phase === 'downloading') {
    const pct = state.progress?.percent != null ? `${state.progress.percent.toFixed(1)}%` : '…'
    line.textContent = `正在下载 v${state.version}（${pct}）`
  } else if (state.phase === 'error') {
    line.textContent = `更新检查失败：${state.error}`
  } else {
    line.textContent = UPDATE_LABEL[state.phase] ?? state.phase
  }
}

api.getUpdateState().then(renderUpdate).catch(() => {})
api.onUpdate(renderUpdate)

$('btn-check-update').addEventListener('click', () => { void api.checkForUpdates() })
$('btn-download-update').addEventListener('click', () => { void api.downloadUpdate() })
$('btn-install-update').addEventListener('click', () => { void api.installUpdate() })

// ── about ──────────────────────────────────────────────────────────────────
api.getVersion().then((version) => { $('about-version').textContent = `v${version}` }).catch(() => {})

}