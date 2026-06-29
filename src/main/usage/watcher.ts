import { join } from 'path'
import chokidar, { type FSWatcher } from 'chokidar'
import { UsageCollector, defaultClaudeDir } from './collector'
import type { UsageSnapshot, WidgetSettings } from '../../shared/types'

/**
 * Claude Code のログを監視し、追記を検知して再集計、スナップショットを push する。
 * ファイル監視（デバウンス付き）＋30秒ポーリングの二重トリガー。
 */
export class UsageWatcher {
  private collector = new UsageCollector()
  private watcher?: FSWatcher
  private pollTimer?: NodeJS.Timeout
  private debounceTimer?: NodeJS.Timeout
  private found = true

  constructor(
    private getSettings: () => WidgetSettings,
    private onSnapshot: (snap: UsageSnapshot) => void
  ) {}

  async start(): Promise<void> {
    await this.tick() // 初回フルスキャン

    const projects = join(defaultClaudeDir(), 'projects')
    this.watcher = chokidar.watch(projects, {
      ignoreInitial: true,
      depth: 2,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
    })
    const onChange = (p: string): void => {
      if (p.endsWith('.jsonl')) this.scheduleTick()
    }
    this.watcher.on('add', onChange).on('change', onChange)

    // 監視準備完了まで待つ（直後の追記を取りこぼさない）
    await new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      this.watcher?.once('ready', done)
      setTimeout(done, 2000) // フォールバック
    })

    this.pollTimer = setInterval(() => void this.tick(), 30_000)
  }

  private scheduleTick(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => void this.tick(), 1200)
  }

  /** 再集計してスナップショットを通知 */
  async tick(): Promise<void> {
    try {
      const { found } = await this.collector.refresh()
      this.found = found
      this.onSnapshot(this.collector.buildSnapshot(this.getSettings(), found))
    } catch (e) {
      // 集計失敗はウィジェットを落とさず無視（次の tick で回復）
      console.error('[UsageWatcher] tick failed:', e)
    }
  }

  /** 再スキャンせず、現在のレコードから即座に再生成（設定変更時など） */
  emitCurrent(): void {
    this.onSnapshot(this.collector.buildSnapshot(this.getSettings(), this.found))
  }

  stop(): void {
    void this.watcher?.close()
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
  }
}
