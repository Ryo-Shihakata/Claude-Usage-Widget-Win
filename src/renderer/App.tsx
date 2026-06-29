import { useEffect, useState } from 'react'
import type { UsageSnapshot, WidgetSettings } from '../shared/types'
import { LimitPanel } from './components/LimitPanel'
import { TokenPanel } from './components/TokenPanel'
import { CostPanel } from './components/CostPanel'

export function App(): JSX.Element {
  const [snap, setSnap] = useState<UsageSnapshot | null>(null)
  const [settings, setSettings] = useState<WidgetSettings | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    const off = window.widget.onUsage(setSnap)
    void window.widget.getSettings().then(setSettings)
    void window.widget.refresh().then((s) => s && setSnap(s))
    return off
  }, [])

  const updateSettings = async (patch: Partial<WidgetSettings>): Promise<void> => {
    const next = await window.widget.setSettings(patch)
    setSettings(next)
  }

  const fiveHM = settings ? Math.round(settings.fiveHourBaselineTokens / 1e6) : 40
  const weeklyM = settings ? Math.round(settings.weeklyBaselineTokens / 1e6) : 200

  return (
    <div className="widget">
      <header className="header drag">
        <span className="title">
          <span className="mark">✳</span>claude usage
        </span>
        <div className="header-actions no-drag">
          <button className="icon-btn" title="今すぐ更新" onClick={() => void window.widget.refresh()}>
            ⟳
          </button>
          <button className="icon-btn" title="設定" onClick={() => setShowSettings((v) => !v)}>
            ⚙
          </button>
        </div>
      </header>

      {showSettings && settings && (
        <div className="settings no-drag">
          <label className="setting-row">
            <span>5時間 基準 (Mtok)</span>
            <input
              type="number"
              min={1}
              value={fiveHM}
              onChange={(e) =>
                void updateSettings({
                  fiveHourBaselineTokens: Math.max(1, Number(e.target.value)) * 1e6
                })
              }
            />
          </label>
          <label className="setting-row">
            <span>1週間 基準 (Mtok)</span>
            <input
              type="number"
              min={1}
              value={weeklyM}
              onChange={(e) =>
                void updateSettings({
                  weeklyBaselineTokens: Math.max(1, Number(e.target.value)) * 1e6
                })
              }
            />
          </label>
          <label className="setting-row checkbox">
            <input
              type="checkbox"
              checked={settings.showCost}
              onChange={(e) => void updateSettings({ showCost: e.target.checked })}
            />
            <span>コスト表示</span>
          </label>
          <label className="setting-row checkbox">
            <input
              type="checkbox"
              checked={settings.launchAtLogin}
              onChange={(e) => void updateSettings({ launchAtLogin: e.target.checked })}
            />
            <span>OS起動時に自動起動</span>
          </label>
          <label className="setting-row checkbox">
            <input
              type="checkbox"
              checked={settings.useOfficialUsage}
              onChange={(e) => void updateSettings({ useOfficialUsage: e.target.checked })}
            />
            <span>公式 /usage を使う（実験的）</span>
          </label>
        </div>
      )}

      {snap ? (
        snap.status ? (
          <div className="status">{snap.status}</div>
        ) : (
          <div className="panels">
            <LimitPanel limits={snap.limits} />
            <TokenPanel today={snap.today} sessionCount={snap.sessionCount} />
            {(!settings || settings.showCost) && (
              <CostPanel today={snap.today} last7d={snap.last7d} />
            )}
          </div>
        )
      ) : (
        <div className="status">読み込み中…</div>
      )}
    </div>
  )
}
