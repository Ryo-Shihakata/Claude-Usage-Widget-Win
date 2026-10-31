import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/ipc'
import type { UsageSnapshot, WidgetSettings } from '../shared/types'

/** 主→renderer のチャンネルを購読。解除関数を返す。 */
function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, value: T): void => cb(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  /** 使用量スナップショットを購読。解除関数を返す。 */
  onUsage(cb: (snap: UsageSnapshot) => void): () => void {
    return subscribe(IPC.usageUpdate, cb)
  },
  /** 設定の変更（トレイからの変更を含む）を購読。解除関数を返す。 */
  onSettings(cb: (settings: WidgetSettings) => void): () => void {
    return subscribe(IPC.settingsChanged, cb)
  },
  getSettings(): Promise<WidgetSettings> {
    return ipcRenderer.invoke(IPC.settingsGet)
  },
  setSettings(patch: Partial<WidgetSettings>): Promise<WidgetSettings> {
    return ipcRenderer.invoke(IPC.settingsSet, patch)
  },
  refresh(): Promise<UsageSnapshot | null> {
    return ipcRenderer.invoke(IPC.refresh)
  },
  loginClaude(): void {
    ipcRenderer.send(IPC.claudeLogin)
  },
  quit(): void {
    ipcRenderer.send(IPC.quit)
  }
}

contextBridge.exposeInMainWorld('widget', api)

export type WidgetApi = typeof api
