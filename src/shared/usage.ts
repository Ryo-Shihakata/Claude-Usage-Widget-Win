// 主プロセス・renderer 双方で使う、使用量まわりの純粋関数
import type { ModelTokens, UsageLimits } from './types'

/** input+output+cache 全種別の合計トークン */
export function sumTokens(t: ModelTokens): number {
  return t.inputTokens + t.outputTokens + t.cacheCreationTokens + t.cacheReadTokens
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/** 利用率の段階。ゲージ・トレイアイコンの色分けに使う */
export type UsageLevel = 'ok' | 'warn' | 'danger'

export function usageLevel(fraction: number): UsageLevel {
  return fraction >= 0.9 ? 'danger' : fraction >= 0.7 ? 'warn' : 'ok'
}

/** 5時間枠・週間枠のどちらかが公式 /usage 由来か */
export function isOfficialLimits(limits: UsageLimits): boolean {
  return limits.fiveHour.source === 'official' || limits.weekly.source === 'official'
}

const MODEL_FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'] as const
export type ModelFamily = (typeof MODEL_FAMILIES)[number]

/** モデルID（や公式レスポンスのキー名）から族名を判定。該当なしは null */
export function modelFamily(s: string): ModelFamily | null {
  const lower = s.toLowerCase()
  return MODEL_FAMILIES.find((f) => lower.includes(f)) ?? null
}

/** 族名の表示名（'opus' → 'Opus'） */
export function familyLabel(f: ModelFamily): string {
  return f.charAt(0).toUpperCase() + f.slice(1)
}

/** Fable/Mythos 系か（専用の週間枠を持つ） */
export function isFableFamily(s: string): boolean {
  const f = modelFamily(s)
  return f === 'fable' || f === 'mythos'
}
