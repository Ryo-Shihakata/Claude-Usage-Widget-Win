import { useEffect, useState } from 'react'
import type { UsageSnapshot, WidgetSettings } from '../shared/types'
import { isOfficialLimits } from '../shared/usage'
import { fmtClock } from './format'
import { LimitPanel } from './components/LimitPanel'
import { TokenPanel } from './components/TokenPanel'
import { CostPanel } from './components/CostPanel'
import { DailyChart } from './components/DailyChart'
import { SettingsPanel } from './components/SettingsPanel'
import { Clawd } from './components/Clawd'

export function App(): JSX.Element {
  const [snap, setSnap] = useState<UsageSnapshot | null>(null)
  const [settings, setSettings] = useState<WidgetSettings | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    const offUsage = window.widget.onUsage(setSnap)
    const offSettings = window.widget.onSettings(setSettings)
    void window.widget.getSettings().then(setSettings)
    void window.widget.refresh().then((s) => s && setSnap(s))
    return () => {
      offUsage()
      offSettings()
    }
  }, [])

  const updateSettings = async (patch: Partial<WidgetSettings>): Promise<void> => {
    setSettings(await window.widget.setSettings(patch))
  }

  const official = !!snap && isOfficialLimits(snap.limits)

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
        <span className="sb-time">{fmtClock(snap?.generatedAt)}</span>
      </footer>

      {showSettings && settings && (
        <SettingsPanel
          settings={settings}
          onChange={(patch) => void updateSettings(patch)}
          onLogin={() => window.widget.loginClaude()}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}
