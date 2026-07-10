import type { PlanLimit, UsageLimits } from '../../shared/types'
import { fmtTokens, fmtResetTime } from '../format'

function level(fraction: number): 'ok' | 'warn' | 'danger' {
  return fraction >= 0.9 ? 'danger' : fraction >= 0.7 ? 'warn' : 'ok'
}

function Gauge({
  label,
  plan,
  markLocalEstimate
}: {
  label: string
  plan: PlanLimit
  /** true のとき、plan.source==='local' なゲージのラベルに「（推定）」を付ける（パネル全体が公式表示のとき用） */
  markLocalEstimate?: boolean
}): JSX.Element {
  const pct = Math.round(plan.fraction * 100)
  const lv = level(plan.fraction)
  const displayLabel = markLocalEstimate && plan.source === 'local' ? `${label}（推定）` : label
  return (
    <div className="gauge-row">
      <div className="gauge-line">
        <span className="gauge-label">{displayLabel}</span>
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

export function LimitPanel({
  limits,
  officialRequested,
  onLogin
}: {
  limits: UsageLimits
  officialRequested: boolean
  onLogin: () => void
}): JSX.Element {
  const official = limits.fiveHour.source === 'official' || limits.weekly.source === 'official'
  // クラウド希望なのに公式値が出ていない＝未ログイン（or 取得失敗）
  const needsLogin = officialRequested && !official
  return (
    <div className="panel limits">
      <div className="panel-head">
        <span className="panel-label">利用枠</span>
        <span className="panel-sub">{official ? '☁ 公式 /usage' : '⌂ 推定（ローカル）'}</span>
      </div>
      <Gauge label="5時間" plan={limits.fiveHour} markLocalEstimate={official} />
      <Gauge label="1週間" plan={limits.weekly} markLocalEstimate={official} />
      {limits.extras?.map((e) => (
        <Gauge key={e.label} label={e.label} plan={e.limit} markLocalEstimate={official} />
      ))}
      {needsLogin && (
        <button className="login-hint no-drag" onClick={onLogin}>
          claude.ai にログインして公式値を表示
        </button>
      )}
    </div>
  )
}
