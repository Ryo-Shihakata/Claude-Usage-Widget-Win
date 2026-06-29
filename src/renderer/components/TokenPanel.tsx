import type { WindowAggregate } from '../../shared/types'
import { fmtTokens, shortModel } from '../format'

export function TokenPanel({
  today,
  sessionCount
}: {
  today: WindowAggregate
  sessionCount: number
}): JSX.Element {
  // トークン合計の多い順に上位2モデルを表示
  const models = Object.entries(today.byModel)
    .map(([model, t]) => ({
      model,
      total: t.inputTokens + t.outputTokens + t.cacheCreationTokens + t.cacheReadTokens
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 2)

  return (
    <div className="panel tokens">
      <div className="panel-head">
        <span className="panel-label">今日のトークン</span>
        <span className="panel-sub">
          {today.messageCount}msg / {sessionCount}sess
        </span>
      </div>
      <div className="model-rows">
        {models.length === 0 && <div className="model-row empty">データなし</div>}
        {models.map((m) => (
          <div className="model-row" key={m.model}>
            <span className="model-name">{shortModel(m.model)}</span>
            <span className="model-tokens">{fmtTokens(m.total)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
