import { join } from 'path'
import { promises as fs } from 'fs'
import { defaultClaudeDir } from './collector'
import type { PlanLimit, UsageLimits } from '../../shared/types'

/**
 * 公式 /usage 実データ（オプトイン）。
 *
 * ⚠️ 重要: この使用量エンドポイントは**非公開**で、レスポンス形状は確定検証できていない
 * （開発サンドボックスではトークン参照がブロックされ、実APIも叩けないため）。
 * 実機で 1 度レスポンスを確認し、必要なら `ENDPOINT` と `mapResponse()` を実形状に合わせて
 * 調整すること。取得・解析に失敗した場合は null を返し、呼び出し側はローカル推定へフォールバックする
 * （＝壊れても害が無い設計）。エンドポイントは環境変数 `CUW_USAGE_ENDPOINT` で上書き可能。
 */
const ENDPOINT =
  process.env.CUW_USAGE_ENDPOINT || 'https://api.anthropic.com/api/oauth/usage'

/** ~/.claude/.credentials.json から OAuth アクセストークンを読む（ユーザー自身のマシン上の自分のトークン） */
async function readAccessToken(): Promise<string | null> {
  const path = join(defaultClaudeDir(), '.credentials.json')
  try {
    const raw = await fs.readFile(path, 'utf8')
    const j = JSON.parse(raw)
    return j?.claudeAiOauth?.accessToken ?? j?.accessToken ?? j?.access_token ?? null
  } catch {
    return null
  }
}

/** util（0..1 または 0..100）と reset 時刻から PlanLimit を作る */
function toLimit(util: unknown, resetsAt: unknown): PlanLimit | null {
  if (typeof util !== 'number' || Number.isNaN(util)) return null
  const fraction = Math.max(0, Math.min(1, util > 1 ? util / 100 : util))
  let iso: string | null = null
  if (typeof resetsAt === 'number') {
    // epoch 秒/ミリ秒どちらでも許容
    iso = new Date(resetsAt < 1e12 ? resetsAt * 1000 : resetsAt).toISOString()
  } else if (typeof resetsAt === 'string') {
    const d = Date.parse(resetsAt)
    iso = Number.isNaN(d) ? null : new Date(d).toISOString()
  }
  return {
    windowTokens: 0,
    baselineTokens: 0,
    fraction,
    windowResetsAt: iso,
    source: 'official'
  }
}

/** 1枠分のオブジェクトから utilization/reset を緩く拾う */
function pickWindow(obj: any): PlanLimit | null {
  if (!obj || typeof obj !== 'object') return null
  const util =
    obj.utilization ?? obj.used_fraction ?? obj.percent ?? obj.usage ?? obj.used ?? undefined
  const reset = obj.resets_at ?? obj.reset_at ?? obj.resetsAt ?? obj.reset ?? obj.expires_at
  return toLimit(util, reset)
}

/**
 * レスポンス JSON から 5時間枠 / 週間枠 を抽出（複数の想定形状を緩く試す）。
 * 実形状が判明したらここを単純化すること。
 */
function mapResponse(data: any): UsageLimits | null {
  if (!data || typeof data !== 'object') return null
  const root = data.unified_rate_limit ?? data.rate_limit ?? data.usage ?? data

  const fiveSrc = root.five_hour ?? root.fiveHour ?? root['5h'] ?? root.session
  const weekSrc = root.seven_day ?? root.sevenDay ?? root['7d'] ?? root.weekly ?? root.week

  const fiveHour = pickWindow(fiveSrc)
  const weekly = pickWindow(weekSrc)
  if (!fiveHour || !weekly) return null
  return { fiveHour, weekly }
}

/** 公式使用量を取得。失敗時は null（呼び出し側はローカル推定を使う）。 */
export async function fetchOfficialLimits(timeoutMs = 5000): Promise<UsageLimits | null> {
  const token = await readAccessToken()
  if (!token) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(ENDPOINT, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json'
      },
      signal: ctrl.signal
    })
    if (!res.ok) return null
    return mapResponse(await res.json())
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
