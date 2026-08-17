// Tray icon + menu: show/hide, status & log panel, auto-launch toggle,
// check updates, quit. Created once on app ready.
import { Menu, Tray, nativeImage } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export function createTray({ getWindow, openPanel, settings, updater, onQuit }) {
  const iconPath = path.join(HERE, '..', 'assets', 'tray.png')
  const icon = nativeImage.createFromPath(iconPath)
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('Dsh-white')

  function rebuildMenu() {
    const settingsSnapshot = settings.get()
    const windowVisible = getWindow() !== null && !getWindow().isDestroyed() && getWindow().isVisible()
    const updateState = updater.getState()
    const menu = Menu.buildFromTemplate([
      {
        label: windowVisible ? '隐藏主窗口' : '显示主窗口',
        click: () => {
          const win = getWindow()
          if (win === null || win.isDestroyed()) return
          if (win.isVisible()) win.hide()
          else { win.show(); win.focus() }
        },
      },
      { label: '日志与状态', click: () => openPanel() },
      { type: 'separator' },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: settingsSnapshot.autoLaunch,
        click: (item) => settings.set({ autoLaunch: item.checked }),
      },
      {
        label: '检查更新…',
        enabled: updater.canUpdate?.() ?? false,
        click: () => { void updater.checkNow() },
      },
      ...(updateState.phase === 'available' || updateState.phase === 'downloaded'
        ? [{
            label: updateState.phase === 'downloaded'
              ? `重启以安装 v${updateState.version}`
              : `下载并安装 v${updateState.version}`,
            click: () => {
              if (updateState.phase === 'downloaded') updater.quitAndInstall()
              else void updater.downloadAndInstall()
            },
          }]
        : []),
      { type: 'separator' },
      { label: '退出', click: () => onQuit() },
    ])
    tray.setContextMenu(menu)
  }

  rebuildMenu()
  const offSettings = settings.onChange(() => rebuildMenu())
  const offUpdate = updater.onState(() => rebuildMenu())

  return {
    tray,
    refresh: rebuildMenu,
    dispose() {
      offSettings()
      offUpdate()
      tray.destroy()
    },
  }
}
