import type { DailyUsage } from '../../shared/types'
import { fmtTokens } from '../format'

/** 'YYYY-MM-DD' → 'M/D' */
function md(date: string): string {
  const [, m, d] = date.split('-')
  return `${Number(m)}/${Number(d)}`
}

/**
 * 直近7日の日毎トークン棒グラフ（単一系列・magnitude）。
 * コーラル単色・ベースライン基準・角丸端。今日の棒だけ明るく。値はホバーで表示。
 */
export function DailyChart({ data }: { data: DailyUsage[] }): JSX.Element {
  const max = Math.max(1, ...data.map((d) => d.tokens))
  return (
    <div className="panel chart">
      <div className="panel-head">
        <span className="panel-label">7日間のトークン</span>
        <span className="panel-sub">日毎合計</span>
      </div>
      <div className="chart-bars">
        {data.map((d, i) => {
          const pct = Math.round((d.tokens / max) * 100)
          const isToday = i === data.length - 1
          return (
            <div className="chart-col" key={d.date} title={`${md(d.date)}: ${fmtTokens(d.tokens)}`}>
              <div className="chart-track">
                <div
                  className={`chart-bar ${isToday ? 'today' : ''}`}
                  style={{ height: `${Math.max(pct, d.tokens > 0 ? 3 : 0)}%` }}
                />
              </div>
              <span className="chart-x">{md(d.date)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
