import type { WindowAggregate } from '../../shared/types'
import { fmtUSD } from '../format'

export function CostPanel({
  today,
  last7d
}: {
  today: WindowAggregate
  last7d: WindowAggregate
}): JSX.Element {
  return (
    <div className="panel cost">
      <div className="panel-head">
        <span className="panel-label">推定コスト</span>
        <span className="panel-sub">参考値</span>
      </div>
      <div className="cost-row">
        <div className="cost-cell">
          <span className="cost-val">{fmtUSD(today.costUSD)}</span>
          <span className="cost-cap">今日</span>
        </div>
        <div className="cost-cell">
          <span className="cost-val">{fmtUSD(last7d.costUSD)}</span>
          <span className="cost-cap">7日</span>
        </div>
      </div>
    </div>
  )
}
