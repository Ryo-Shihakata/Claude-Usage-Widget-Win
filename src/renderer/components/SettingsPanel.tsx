import type { WidgetSettings } from '../../shared/types'

type NumberKey = {
  [K in keyof WidgetSettings]: WidgetSettings[K] extends number ? K : never
}[keyof WidgetSettings]
type BooleanKey = {
  [K in keyof WidgetSettings]: WidgetSettings[K] extends boolean ? K : never
}[keyof WidgetSettings]

/** 基準トークン数（Mtok 単位で入力） */
const BASELINES: { key: NumberKey; label: string }[] = [
  { key: 'fiveHourBaselineTokens', label: '5時間 基準 (Mtok)' },
  { key: 'weeklyBaselineTokens', label: '1週間 基準 (Mtok)' },
  { key: 'fableWeeklyBaselineTokens', label: '週(Fable) 基準 (Mtok)' }
]

const TOGGLES: { key: BooleanKey; label: string }[] = [
  { key: 'showFableWeekly', label: '週(Fable) ゲージを表示' },
  { key: 'showChart', label: '日毎グラフを表示' },
  { key: 'showCost', label: 'コスト表示' },
  { key: 'launchAtLogin', label: 'OS起動時に自動起動' },
  { key: 'useOfficialUsage', label: '公式 /usage（クラウド）を使う' }
]

export function SettingsPanel({
  settings,
  onChange,
  onLogin,
  onClose
}: {
  settings: WidgetSettings
  onChange: (patch: Partial<WidgetSettings>) => void
  onLogin: () => void
  onClose: () => void
}): JSX.Element {
  return (
    <div className="settings-overlay no-drag">
      <div className="settings">
        {BASELINES.map(({ key, label }) => (
          <label className="setting-row" key={key}>
            <span>{label}</span>
            <input
              type="number"
              min={1}
              value={Math.round(settings[key] / 1e6)}
              onChange={(e) => onChange({ [key]: Math.max(1, Number(e.target.value)) * 1e6 })}
            />
          </label>
        ))}
        {TOGGLES.map(({ key, label }) => (
          <label className="setting-row checkbox" key={key}>
            <input
              type="checkbox"
              checked={settings[key]}
              onChange={(e) => onChange({ [key]: e.target.checked })}
            />
            <span>{label}</span>
          </label>
        ))}
        <button className="settings-btn" onClick={onLogin}>
          claude.ai にログイン
        </button>
        <button className="settings-btn ghost" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  )
}
