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
  const m = model.toLowerCase()
  if (m.includes('opus')) return 'Opus'
  if (m.includes('sonnet')) return 'Sonnet'
  if (m.includes('haiku')) return 'Haiku'
  if (m.includes('fable')) return 'Fable'
  return model.replace(/^claude-/, '')
}

/** ISO 時刻を「HH:MM まで」に */
export function fmtResetTime(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}
