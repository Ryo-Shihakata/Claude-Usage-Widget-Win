// 集計ロジックの単体検証用 CLI。`npm run collect` で実行。
// stats-cache.json の値と照合して集計の正しさを確認する。
import { UsageCollector } from './collector'
import { DEFAULT_SETTINGS } from '../../shared/types'

async function main(): Promise<void> {
  const collector = new UsageCollector()
  const start = Date.now()
  const { found } = await collector.refresh()
  const elapsed = Date.now() - start
  const snap = collector.buildSnapshot(DEFAULT_SETTINGS, found)

  const fmt = (n: number): string => n.toLocaleString('en-US')
  console.log(`データ検出: ${found}  / 走査時間: ${elapsed}ms`)
  console.log('--- 今日 ---')
  for (const [model, t] of Object.entries(snap.today.byModel)) {
    const total = t.inputTokens + t.outputTokens + t.cacheCreationTokens + t.cacheReadTokens
    console.log(
      `  ${model}: total ${fmt(total)} ` +
        `(in ${fmt(t.inputTokens)} / out ${fmt(t.outputTokens)} / ` +
        `cacheW ${fmt(t.cacheCreationTokens)} / cacheR ${fmt(t.cacheReadTokens)})`
    )
  }
  console.log(`  メッセージ数: ${snap.today.messageCount}  セッション数: ${snap.sessionCount}`)
  console.log(`  推定コスト: $${snap.today.costUSD.toFixed(4)}`)

  const printLimit = (label: string, l: typeof snap.limits.fiveHour): void => {
    console.log(`--- ${label}（推定） ---`)
    console.log(
      `  消費トークン: ${fmt(l.windowTokens)} / 基準 ${fmt(l.baselineTokens)} ` +
        `= ${(l.fraction * 100).toFixed(1)}%`
    )
    console.log(`  枠リセット目安: ${l.windowResetsAt ?? '-'}`)
  }
  printLimit('5時間枠', snap.limits.fiveHour)
  printLimit('週間枠', snap.limits.weekly)

  console.log('--- 直近7日（集計） ---')
  console.log(
    `  total ${fmt(snap.last7d.totalTokens)} / ` +
      `msg ${snap.last7d.messageCount} / $${snap.last7d.costUSD.toFixed(4)}`
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
