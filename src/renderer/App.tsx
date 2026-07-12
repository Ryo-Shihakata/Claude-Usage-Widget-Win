import { useEffect, useState } from 'react'
import type { UsageSnapshot, WidgetSettings } from '../shared/types'
import { LimitPanel } from './components/LimitPanel'
import { TokenPanel } from './components/TokenPanel'
import { CostPanel } from './components/CostPanel'
import { DailyChart } from './components/DailyChart'
import { Clawd } from './components/Clawd'

function clock(iso: string | undefined): string {
  if (!iso) return '--:--'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--'
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

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

  const fiveHM = settings ? Math.round(settings.fiveHourBaselineTokens / 1e6) : 85
  const weeklyM = settings ? Math.round(settings.weeklyBaselineTokens / 1e6) : 430
  const fableM = settings ? Math.round(settings.fableWeeklyBaselineTokens / 1e6) : 150
  const official =
    !!snap &&
    (snap.limits.fiveHour.source === 'official' || snap.limits.weekly.source === 'official')

  return (
    <div className="widget">
      <header className="term-header drag">
        <span className="term-title">
          claude@usage<span className="cursor">▊</span>
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

      <div className="body">
        {snap ? (
          snap.status ? (
            <div className="status">{snap.status}</div>
          ) : (
            <div className="panels">
              <LimitPanel
                limits={snap.limits}
                officialRequested={!!settings?.useOfficialUsage}
                onLogin={() => window.widget.loginClaude()}
              />
              <TokenPanel today={snap.today} sessionCount={snap.sessionCount} />
              {(!settings || settings.showChart) && <DailyChart data={snap.daily} />}
              {(!settings || settings.showCost) && (
                <CostPanel today={snap.today} last7d={snap.last7d} />
              )}
            </div>
          )
        ) : (
          <div className="status">読み込み中…</div>
        )}
      </div>

      <footer className="statusbar">
        <Clawd size={16} />
        <span className={`sb-mode ${official ? 'cloud' : 'local'}`}>
          {official ? '☁ 公式' : '⌂ 推定'}
        </span>
        <span className="sb-watch">watching ~/.claude</span>
        <span className="sb-time">{clock(snap?.generatedAt)}</span>
      </footer>

      {showSettings && settings && (
        <div className="settings-overlay no-drag">
          <div className="settings">
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
            <label className="setting-row">
              <span>週(Fable) 基準 (Mtok)</span>
              <input
                type="number"
                min={1}
                value={fableM}
                onChange={(e) =>
                  void updateSettings({
                    fableWeeklyBaselineTokens: Math.max(1, Number(e.target.value)) * 1e6
                  })
                }
              />
            </label>
            <label className="setting-row checkbox">
              <input
                type="checkbox"
                checked={settings.showFableWeekly}
                onChange={(e) => void updateSettings({ showFableWeekly: e.target.checked })}
              />
              <span>週(Fable) ゲージを表示</span>
            </label>
            <label className="setting-row checkbox">
              <input
                type="checkbox"
                checked={settings.showChart}
                onChange={(e) => void updateSettings({ showChart: e.target.checked })}
              />
              <span>日毎グラフを表示</span>
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
              <span>公式 /usage（クラウド）を使う</span>
            </label>
            <button className="settings-btn" onClick={() => window.widget.loginClaude()}>
              claude.ai にログイン
            </button>
            <button className="settings-btn ghost" onClick={() => setShowSettings(false)}>
              閉じる
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
