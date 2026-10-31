import type { LabeledLimit, PlanLimit, UsageLimits } from '../../shared/types'
import { clamp01, familyLabel, modelFamily } from '../../shared/usage'
import { dbg } from './officialLog'

// 公式 /usage レスポンスの解析（Electron 非依存の純粋関数。テスト対象）

/** five_hour / seven_day の1枠を PlanLimit に変換 */
function toLimit(w: any): PlanLimit | null {
  if (!w || typeof w.utilization !== 'number') return null
  const reset = w.resets_at ?? w.resetsAt ?? null
  let iso: string | null = null
  if (typeof reset === 'string') {
    const t = Date.parse(reset)
    iso = Number.isNaN(t) ? null : new Date(t).toISOString()
  }
  return {
    windowTokens: 0,
    baselineTokens: 0,
    fraction: clamp01(w.utilization / 100),
    windowResetsAt: iso,
    source: 'official'
  }
}

/** 追加枠のキー名を日本語ラベルへ（未知キーは整形して表示） */
function labelFor(key: string): string {
  const known: Record<string, string> = {
    seven_day_oauth_apps: '週(アプリ)'
  }
  if (known[key]) return known[key]
  // 一般化: <window>_<model> → 「<窓>(<Model>)」（例: seven_day_opus→週(Opus), seven_day_fable→週(Fable)）
  const win = key.includes('seven_day') ? '週' : key.includes('five_hour') ? '5時間' : ''
  const family = modelFamily(key)
  if (win && family) return `${win}(${familyLabel(family)})`
  return key
    .replace(/seven_day/g, '週')
    .replace(/five_hour/g, '5時間')
    .replace(/_/g, ' ')
    .trim()
}

/** `utilization`(number) を持つオブジェクトか判定 */
function isUtilizationLeaf(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && typeof (v as any).utilization === 'number'
}

/** 配列要素のキーパス末尾セグメント。model/name/key の文字列フィールドがあればそれを使い、無ければ添字 */
function arrayElementLabelSegment(el: Record<string, any>, index: number): string {
  const v = el.model ?? el.name ?? el.key
  return typeof v === 'string' && v ? v : String(index)
}

/** leaf を extras に追加（toLimit が null を返す形なら何もしない） */
function pushExtra(out: LabeledLimit[], path: string[], leaf: unknown): void {
  const limit = toLimit(leaf)
  if (limit) out.push({ label: labelFor(path.join('_')), limit })
}

/**
 * `utilization` を持つオブジェクトを再帰的に探索し extras 候補を集める。
 * `depthLeft` は「現在のノードの子（またはその配列要素）を検査してよい残り階層数」。
 * 呼び出し元で depthLeft=1 を渡すと、このノード自身の子を検査する（＝深さ2）のみ許可し、
 * その子がさらに非leafでもそこから先（深さ3）へは descend しない。
 * five_hour/seven_day 相当や、既に extras として拾ったオブジェクトの子は二重に探索しない
 * （utilization leaf を見つけた時点でその配下へは descend しない）。
 */
function walkForExtras(node: unknown, path: string[], depthLeft: number, out: LabeledLimit[]): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((el, idx) => {
      if (isUtilizationLeaf(el)) pushExtra(out, [...path, arrayElementLabelSegment(el, idx)], el)
      else if (depthLeft > 1) walkForExtras(el, path, depthLeft - 1, out)
    })
    return
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (isUtilizationLeaf(v)) pushExtra(out, [...path, k], v)
    else if (depthLeft > 1) walkForExtras(v, [...path, k], depthLeft - 1, out)
  }
}

/**
 * レスポンスを UsageLimits に変換。five_hour/seven_day は必須トップレベル、
 * その他の `utilization` を持つキーは extras（例: 週(Opus)）として拾う。
 * トップレベルキー自体が `utilization` を持つフラット形状（例: seven_day_opus。実レスポンスはこれ）に加え、
 * `{ model_limits: { fable: { utilization } } }` のようなネストや、
 * `[{ model: 'fable', utilization, resets_at }]` のような配列も**深さ2まで**再帰的に探索する。
 */
export function mapUsage(data: any): UsageLimits | null {
  if (!data || typeof data !== 'object') return null
  dbg('response top-level keys:', Object.keys(data))
  const five = toLimit(data.five_hour)
  const week = toLimit(data.seven_day)
  if (!five || !week) return null
  const extras: LabeledLimit[] = []
  for (const [key, val] of Object.entries(data)) {
    if (key === 'five_hour' || key === 'seven_day') continue
    // フラット形状: このキー自体が utilization leaf → 子は探索しない。
    // ネスト/配列形状: この階層(1)+1階層=深さ2まで utilization leaf を探索
    if (isUtilizationLeaf(val)) pushExtra(extras, [key], val)
    else walkForExtras(val, [key], 1, extras)
  }
  dbg(
    'extras collected:',
    extras.map((e) => e.label)
  )
  return { fiveHour: five, weekly: week, extras: extras.length ? extras : undefined }
}
