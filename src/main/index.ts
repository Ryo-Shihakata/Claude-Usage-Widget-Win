import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { createWidgetWindow, type WindowBounds } from './window'
import { JsonStore } from './store'
import { UsageWatcher } from './usage/watcher'
import { openClaudeLogin, isClaudeLoggedIn } from './usage/officialUsage'
import { renderTrayIcon } from './trayIcon'
import electronUpdater from 'electron-updater'
import { IPC } from '../shared/ipc'

const { autoUpdater } = electronUpdater
import { DEFAULT_SETTINGS, type UsageSnapshot, type WidgetSettings } from '../shared/types'

let win: BrowserWindow | null = null
let tray: Tray | null = null
let watcher: UsageWatcher | null = null
let lastSnapshot: UsageSnapshot | null = null

// app ready 後に初期化（userData パスは ready 後に確定するため）
let settingsStore: JsonStore<WidgetSettings>
let boundsStore: JsonStore<WindowBounds>

// 単一インスタンスに限定
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

function resolveIconPath(): string {
  // dev: プロジェクトの resources/、prod: out/ と同階層の resources/
  const candidates = [
    join(__dirname, '../../resources/icon.png'),
    join(process.resourcesPath, 'resources/icon.png')
  ]
  return candidates.find((p) => existsSync(p)) ?? candidates[0]
}

function pushSnapshot(snap: UsageSnapshot): void {
  lastSnapshot = snap
  win?.webContents.send(IPC.usageUpdate, snap)
  updateTrayIndicator(snap)
}

/** トレイのアイコン（リングゲージ）とツールチップを最新の使用量で更新 */
function updateTrayIndicator(snap: UsageSnapshot): void {
  if (!tray) return
  const f5 = snap.limits.fiveHour.fraction
  const fw = snap.limits.weekly.fraction
  tray.setImage(nativeImage.createFromBuffer(renderTrayIcon(Math.max(f5, fw))))
  tray.setToolTip(
    `Claude Usage\n5時間: ${Math.round(f5 * 100)}%  /  1週間: ${Math.round(fw * 100)}%`
  )
}

function applyAlwaysOnTop(value: boolean): void {
  if (!win) return
  win.setAlwaysOnTop(value, 'screen-saver')
}

function buildTray(): void {
  const icon = nativeImage.createFromPath(resolveIconPath())
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('Claude Usage Widget')
  refreshTrayMenu()
  tray.on('click', () => toggleWindow())
}

function refreshTrayMenu(): void {
  if (!tray) return
  const s = settingsStore.get()
  const menu = Menu.buildFromTemplate([
    { label: '表示 / 非表示', click: () => toggleWindow() },
    {
      label: '常に最前面',
      type: 'checkbox',
      checked: s.alwaysOnTop,
      click: (item) => {
        const next = settingsStore.set({ alwaysOnTop: item.checked })
        applyAlwaysOnTop(next.alwaysOnTop)
        watcher?.emitCurrent()
      }
    },
    {
      label: 'コスト表示',
      type: 'checkbox',
      checked: s.showCost,
      click: (item) => {
        settingsStore.set({ showCost: item.checked })
        watcher?.emitCurrent()
        refreshTrayMenu()
      }
    },
    {
      label: 'OS起動時に自動起動',
      type: 'checkbox',
      checked: s.launchAtLogin,
      click: (item) => {
        settingsStore.set({ launchAtLogin: item.checked })
        app.setLoginItemSettings({ openAtLogin: item.checked })
        refreshTrayMenu()
      }
    },
    {
      label: '公式 /usage を使う（実験的）',
      type: 'checkbox',
      checked: s.useOfficialUsage,
      click: (item) => {
        settingsStore.set({ useOfficialUsage: item.checked })
        if (item.checked) void ensureClaudeLogin()
        void watcher?.tick()
        refreshTrayMenu()
      }
    },
    { label: 'claude.ai にログイン（公式 /usage 用）', click: () => openClaudeLogin() },
    { type: 'separator' },
    { label: '今すぐ更新', click: () => void watcher?.tick() },
    { type: 'separator' },
    { label: '終了', click: () => app.quit() }
  ])
  tray.setContextMenu(menu)
}

/** 公式 /usage 利用時、未ログインならログインウィンドウを開く */
async function ensureClaudeLogin(): Promise<void> {
  if (!(await isClaudeLoggedIn())) openClaudeLogin()
}

function toggleWindow(): void {
  if (!win) return
  if (win.isVisible()) win.hide()
  else win.show()
}

function registerIpc(): void {
  ipcMain.handle(IPC.settingsGet, () => settingsStore.get())
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<WidgetSettings>) => {
    const next = settingsStore.set(patch)
    if (patch.alwaysOnTop !== undefined) applyAlwaysOnTop(next.alwaysOnTop)
    if (patch.launchAtLogin !== undefined) {
      app.setLoginItemSettings({ openAtLogin: next.launchAtLogin })
    }
    if (patch.useOfficialUsage === true) void ensureClaudeLogin()
    // 公式トグル変更時は再取得（emitCurrent は再フェッチしないため tick を使う）
    if (patch.useOfficialUsage !== undefined) void watcher?.tick()
    else watcher?.emitCurrent()
    refreshTrayMenu()
    return next
  })
  ipcMain.handle(IPC.refresh, async () => {
    await watcher?.tick()
    return lastSnapshot
  })
  ipcMain.on(IPC.quit, () => app.quit())
}

/** GitHub Releases からの自動アップデート（パッケージ版のみ）。 */
function setupAutoUpdate(): void {
  if (!app.isPackaged) return // dev では無効（dev-app-update.yml が無く例外になるため）
  autoUpdater.autoDownload = true
  autoUpdater.on('error', (e) => console.error('[autoUpdater]', e))
  const check = (): void => {
    autoUpdater.checkForUpdatesAndNotify().catch((e) => console.error('[autoUpdater]', e))
  }
  check() // 起動時
  setInterval(check, 6 * 60 * 60 * 1000) // 6時間ごと。DL完了で通知し、次回終了時に適用。
}

app.whenReady().then(async () => {
  settingsStore = new JsonStore<WidgetSettings>('settings.json', DEFAULT_SETTINGS)
  boundsStore = new JsonStore<WindowBounds>('window-bounds.json', {})

  registerIpc()

  win = createWidgetWindow({
    bounds: boundsStore.get(),
    alwaysOnTop: settingsStore.get().alwaysOnTop,
    onMoved: (b) => boundsStore.set(b)
  })

  // renderer が読み込まれたら直近スナップショットを送る
  win.webContents.on('did-finish-load', () => {
    if (lastSnapshot) pushSnapshot(lastSnapshot)
  })

  buildTray()

  // 設定通りの自動起動状態を OS に反映
  app.setLoginItemSettings({ openAtLogin: settingsStore.get().launchAtLogin })

  watcher = new UsageWatcher(
    () => settingsStore.get(),
    (snap) => pushSnapshot(snap)
  )
  await watcher.start()

  setupAutoUpdate()
})

app.on('second-instance', () => {
  if (win) {
    win.show()
    win.focus()
  }
})

// ウィジェットはトレイ常駐。全ウィンドウを閉じても終了しない。
app.on('window-all-closed', () => {
  // no-op（トレイから終了する）
})

app.on('before-quit', () => watcher?.stop())
