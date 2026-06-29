import type { ModelTokens } from '../../shared/types'

/**
 * モデル別の公開単価（USD / 100万トークン = MTok）。
 * 出典: claude-api スキル（cached 2026-06）。
 * cacheRead ≈ input × 0.1、cacheWrite(5分TTL) ≈ input × 1.25。
 * サブスクリプション利用では実際の請求は発生しないため、表示は「参考値」。
 */
interface ModelRate {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const RATES: Record<string, ModelRate> = {
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }
}

/** 完全一致が無い場合に族名から単価を推定（例: 将来の opus / sonnet / haiku 派生） */
function resolveRate(model: string): ModelRate | null {
  if (RATES[model]) return RATES[model]
  const lower = model.toLowerCase()
  if (lower.includes('opus')) return RATES['claude-opus-4-8']
  if (lower.includes('sonnet')) return RATES['claude-sonnet-4-6']
  if (lower.includes('haiku')) return RATES['claude-haiku-4-5']
  return null
}

const PER_TOKEN = 1 / 1_000_000

/** 1モデル分のトークン内訳から推定コスト(USD)を算出。単価不明なら 0。 */
export function estimateCost(model: string, t: ModelTokens): number {
  const rate = resolveRate(model)
  if (!rate) return 0
  return (
    t.inputTokens * rate.input * PER_TOKEN +
    t.outputTokens * rate.output * PER_TOKEN +
    t.cacheReadTokens * rate.cacheRead * PER_TOKEN +
    t.cacheCreationTokens * rate.cacheWrite * PER_TOKEN
  )
}
