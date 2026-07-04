import { BrowserWindow } from 'electron'
import { join } from 'path'

export interface WindowBounds {
  x?: number
  y?: number
  width?: number
  height?: number
}

const DEFAULT_WIDTH = 280
const DEFAULT_HEIGHT = 430

/** フレームレス・半透明・常時最前面・リサイズ可能なフローティングウィンドウを生成 */
export function createWidgetWindow(opts: {
  bounds: WindowBounds
  alwaysOnTop: boolean
  onBounds: (b: WindowBounds) => void
}): BrowserWindow {
  const win = new BrowserWindow({
    width: opts.bounds.width ?? DEFAULT_WIDTH,
    height: opts.bounds.height ?? DEFAULT_HEIGHT,
    x: opts.bounds.x,
    y: opts.bounds.y,
    minWidth: 220,
    minHeight: 180,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: opts.alwaysOnTop,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  if (opts.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver')

  const save = (): void => {
    const b = win.getBounds()
    opts.onBounds({ x: b.x, y: b.y, width: b.width, height: b.height })
  }
  // リサイズはドラッグ中に多発するためデバウンス保存。移動は即保存。
  let resizeTimer: NodeJS.Timeout | undefined
  win.on('moved', save)
  win.on('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(save, 400)
  })

  win.once('ready-to-show', () => win.show())

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}
