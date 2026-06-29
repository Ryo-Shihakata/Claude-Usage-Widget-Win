import type { PlanLimit, UsageLimits } from '../../shared/types'
import { fmtTokens, fmtResetTime } from '../format'

function level(fraction: number): 'ok' | 'warn' | 'danger' {
  return fraction >= 0.9 ? 'danger' : fraction >= 0.7 ? 'warn' : 'ok'
}

function Gauge({ label, plan }: { label: string; plan: PlanLimit }): JSX.Element {
  const pct = Math.round(plan.fraction * 100)
  const lv = level(plan.fraction)
  return (
    <div className="gauge-row">
      <div className="gauge-line">
        <span className="gauge-label">{label}</span>
        <span className={`gauge-pct ${lv}`}>{pct}%</span>
      </div>
      <div className="gauge">
        <div className={`gauge-fill ${lv}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="gauge-sub">
        <span>
          {plan.source === 'official'
            ? '公式値'
            : `${fmtTokens(plan.windowTokens)} / ${fmtTokens(plan.baselineTokens)}`}
        </span>
        <span>〜{fmtResetTime(plan.windowResetsAt)} 緩和</span>
      </div>
    </div>
  )
}

export function LimitPanel({ limits }: { limits: UsageLimits }): JSX.Element {
  const official = limits.fiveHour.source === 'official' || limits.weekly.source === 'official'
  return (
    <div className="panel limits">
      <div className="panel-head">
        <span className="panel-label">利用枠</span>
        <span className="panel-sub">{official ? '公式 /usage' : '推定（ローカル集計）'}</span>
      </div>
      <Gauge label="5時間" plan={limits.fiveHour} />
      <Gauge label="1週間" plan={limits.weekly} />
    </div>
  )
}
