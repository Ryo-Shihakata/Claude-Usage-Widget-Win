import { familyLabel, modelFamily } from '../shared/usage'

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** トークン数を 5.1M のようにコンパクト表記 */
export function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}

/** USD 表記 */
export function fmtUSD(n: number): string {
  if (n >= 100) return '$' + n.toFixed(0)
  return '$' + n.toFixed(2)
}

/** モデルIDを短い表示名に */
export function shortModel(model: string): string {
  const family = modelFamily(model)
  return family ? familyLabel(family) : model.replace(/^claude-/, '')
}

/** ISO 時刻を「HH:MM」に。今日でなければ「M/D HH:MM」に */
export function fmtResetTime(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  const hh = pad2(d.getHours())
  const mm = pad2(d.getMinutes())
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
}

/** ISO 時刻を「HH:MM:SS」に（ステータスバーの最終更新時刻） */
export function fmtClock(iso: string | undefined): string {
  if (!iso) return '--:--'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--'
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}
