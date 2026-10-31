import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  type MenuItemConstructorOptions
} from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { createWidgetWindow, type WindowBounds } from './window'
import { JsonStore } from './store'
import { UsageWatcher } from './usage/watcher'
import { openClaudeLogin, isClaudeLoggedIn } from './usage/officialUsage'
import { renderTrayIcon } from './trayIcon'
import { IPC } from '../shared/ipc'
import { DEFAULT_SETTINGS, type UsageSnapshot, type WidgetSettings } from '../shared/types'

let win: BrowserWindow | null = null
let tray: Tray | null = null
let watcher: UsageWatcher | null = null
let lastSnapshot: UsageSnapshot | null = null

// app ready 後に初期化（userData パスは ready 後に確定するため）
let settingsStore: JsonStore<WidgetSettings>
let boundsStore: JsonStore<WindowBounds>

// ELECTRON_RUN_AS_NODE 環境（Claude Code のシェル等）では Electron が素の Node として動き
// app が取れない。意味不明な TypeError で落ちる前に理由を明示して終了する。
if (!app) {
  console.error(
    '[claude-usage-widget] Electron の app API が取得できません。' +
      'ELECTRON_RUN_AS_NODE が設定された環境では GUI を起動できません（通常のターミナルから npm run dev を実行してください）。'
  )
  process.exit(1)
}

// dev とインストール版で userData を分離する。分離しないと同じ lockfile・キャッシュを
// 奪い合い、インストール版が常駐している間は dev が単一インスタンスロックを取れず
// 「Unable to move the cache: アクセスが拒否されました」を出した後、無言で終了する。
if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('userData'), '..', 'claude-usage-widget-dev'))
}

// 単一インスタンスに限定
if (!app.requestSingleInstanceLock()) {
  console.error(
    '[claude-usage-widget] 既に同じインスタンスが起動しているため終了します（トレイを確認してください）。'
  )
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
  win?.setAlwaysOnTop(value, 'screen-saver')
}

/**
 * OS ログイン時自動起動の登録。
 * dev では process.execPath が素の electron.exe を指すため、これを登録すると
 * 次回 OS ログイン時に「Electron デモ（welcome画面）」が起動してしまう。
 * よって dev では常に解除し、stale なスタートアップ登録も掃除する。
 */
function applyLoginItem(enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: app.isPackaged && enabled })
}

function buildTray(): void {
  const icon = nativeImage.createFromPath(resolveIconPath())
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('Claude Usage Widget')
  refreshTrayMenu()
  tray.on('click', () => toggleWindow())
}

/** 真偽値の設定を切り替えるトレイのチェックボックス項目 */
type BooleanSettingKey = {
  [K in keyof WidgetSettings]: WidgetSettings[K] extends boolean ? K : never
}[keyof WidgetSettings]

function settingCheckbox(
  label: string,
  key: BooleanSettingKey,
  s: WidgetSettings
): MenuItemConstructorOptions {
  return {
    label,
    type: 'checkbox',
    checked: s[key],
    click: (item) => applySettingsPatch({ [key]: item.checked })
  }
}

function refreshTrayMenu(): void {
  if (!tray) return
  const s = settingsStore.get()
  const menu = Menu.buildFromTemplate([
    { label: '表示 / 非表示', click: () => toggleWindow() },
    settingCheckbox('常に最前面', 'alwaysOnTop', s),
    settingCheckbox('コスト表示', 'showCost', s),
    settingCheckbox('OS起動時に自動起動', 'launchAtLogin', s),
    settingCheckbox('公式 /usage を使う（実験的）', 'useOfficialUsage', s),
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

/**
 * 設定変更の唯一の入口（設定オーバーレイ・トレイの両方から呼ぶ）。
 * 保存 → OS/ウィンドウへの反映 → 再集計 → トレイ・renderer へ通知。
 */
function applySettingsPatch(patch: Partial<WidgetSettings>): WidgetSettings {
  const next = settingsStore.set(patch)
  if (patch.alwaysOnTop !== undefined) applyAlwaysOnTop(next.alwaysOnTop)
  if (patch.launchAtLogin !== undefined) applyLoginItem(next.launchAtLogin)
  if (patch.useOfficialUsage === true) void ensureClaudeLogin()
  // 公式トグル変更時は再取得（emitCurrent は再フェッチしないため tick を使う）
  if (patch.useOfficialUsage !== undefined) void watcher?.tick()
  else watcher?.emitCurrent()
  refreshTrayMenu()
  win?.webContents.send(IPC.settingsChanged, next)
  return next
}

function registerIpc(): void {
  ipcMain.handle(IPC.settingsGet, () => settingsStore.get())
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<WidgetSettings>) => applySettingsPatch(patch))
  ipcMain.handle(IPC.refresh, async () => {
    await watcher?.tick()
    return lastSnapshot
  })
  ipcMain.on(IPC.claudeLogin, () => openClaudeLogin())
  ipcMain.on(IPC.quit, () => app.quit())
}

/** GitHub Releases からの自動アップデート（パッケージ版のみ）。 */
async function setupAutoUpdate(): Promise<void> {
  if (!app.isPackaged) return // dev では無効（dev-app-update.yml が無く例外になるため）
  // 遅延import: electron-updater は import した時点で app.getVersion() に触るため、
  // トップレベルで読み込むと dev や ELECTRON_RUN_AS_NODE 環境で起動前にクラッシュする
  const { autoUpdater } = (await import('electron-updater')).default
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
    onBounds: (b) => boundsStore.set(b)
  })

  // renderer が読み込まれたら直近スナップショットを送る
  win.webContents.on('did-finish-load', () => {
    if (lastSnapshot) pushSnapshot(lastSnapshot)
  })

  buildTray()

  // 設定通りの自動起動状態を OS に反映（dev では登録解除＝stale掃除）
  applyLoginItem(settingsStore.get().launchAtLogin)

  watcher = new UsageWatcher(
    () => settingsStore.get(),
    (snap) => pushSnapshot(snap)
  )
  await watcher.start()

  void setupAutoUpdate().catch((e) => console.error('[autoUpdater] setup failed:', e))
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
