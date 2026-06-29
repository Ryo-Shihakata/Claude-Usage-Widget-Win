import { BrowserWindow } from 'electron'
import { join } from 'path'

export interface WindowBounds {
  x?: number
  y?: number
}

/** フレームレス・半透明・常時最前面のフローティングウィンドウを生成 */
export function createWidgetWindow(opts: {
  bounds: WindowBounds
  alwaysOnTop: boolean
  onMoved: (b: { x: number; y: number }) => void
}): BrowserWindow {
  const win = new BrowserWindow({
    width: 270,
    height: 286,
    x: opts.bounds.x,
    y: opts.bounds.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
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

  win.on('moved', () => {
    const [x, y] = win.getPosition()
    opts.onMoved({ x, y })
  })

  win.once('ready-to-show', () => win.show())

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}
