import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/ipc'
import type { UsageSnapshot, WidgetSettings } from '../shared/types'

const api = {
  /** 使用量スナップショットを購読。解除関数を返す。 */
  onUsage(cb: (snap: UsageSnapshot) => void): () => void {
    const listener = (_e: IpcRendererEvent, snap: UsageSnapshot): void => cb(snap)
    ipcRenderer.on(IPC.usageUpdate, listener)
    return () => ipcRenderer.removeListener(IPC.usageUpdate, listener)
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
  quit(): void {
    ipcRenderer.send(IPC.quit)
  }
}

contextBridge.exposeInMainWorld('widget', api)

export type WidgetApi = typeof api
