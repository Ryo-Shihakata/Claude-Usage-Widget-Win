// 主プロセス ↔ renderer の IPC チャンネル名（preload 経由で公開）
export const IPC = {
  /** 主→renderer: 新しい使用量スナップショット */
  usageUpdate: 'usage:update',
  /** renderer→主: 現在の設定を取得 */
  settingsGet: 'settings:get',
  /** renderer→主: 設定を更新（差分） */
  settingsSet: 'settings:set',
  /** renderer→主: 即時再集計を要求 */
  refresh: 'usage:refresh',
  /** renderer→主: ウィンドウを閉じる/終了 */
  quit: 'app:quit'
} as const
