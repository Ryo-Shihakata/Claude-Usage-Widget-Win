// 主プロセス・renderer 双方で共有する型定義

/** モデル別のトークン内訳 */
export interface ModelTokens {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

/** ある集計ウィンドウ（今日 / 直近5h / 直近7d）の集計結果 */
export interface WindowAggregate {
  /** モデルID -> トークン内訳 */
  byModel: Record<string, ModelTokens>
  /** input+output+cache 全種別の合計トークン */
  totalTokens: number
  /** メッセージ（assistant 応答）数 */
  messageCount: number
  /** 公開単価で換算した推定コスト(USD)。サブスクのため参考値 */
  costUSD: number
}

/**
 * レート制限枠の消費目安。Claude の「5時間枠」「週間」に対応するが、
 * 値は**ローカルログから集計したトークン量に基づく推定**であり、
 * 公式 `/usage` の残量とは異なる（公式値はローカルに存在しない）。
 */
export interface PlanLimit {
  /** この枠で消費したトークン（input+output+cache合計）。official 時は省略され得る */
  windowTokens: number
  /** 設定された基準値（この値で 100% とみなす）。official 時は意味を持たない */
  baselineTokens: number
  /** 0..1 にクランプした消費率 */
  fraction: number
  /** 枠内の最も古いメッセージが枠から外れる推定時刻(ISO)。データが無ければ null */
  windowResetsAt: string | null
  /** 値の出所: 'local'=ローカル集計の推定 / 'official'=公式 /usage 実データ */
  source: 'local' | 'official'
}

/** 2種のレート制限枠（推定） */
export interface UsageLimits {
  /** 直近5時間枠 */
  fiveHour: PlanLimit
  /** 直近7日（週間）枠 */
  weekly: PlanLimit
}

/** renderer に push する1スナップショット */
export interface UsageSnapshot {
  /** 生成時刻(ISO) */
  generatedAt: string
  today: WindowAggregate
  last5h: WindowAggregate
  last7d: WindowAggregate
  /** 5時間枠・週間枠の消費目安（推定） */
  limits: UsageLimits
  /** 今日アクティブだった distinct セッション数 */
  sessionCount: number
  /** データソースが見つからない等の状態メッセージ（正常時は null） */
  status: string | null
}

/** ユーザー設定 */
export interface WidgetSettings {
  /** 5時間枠ゲージの基準トークン数（分母） */
  fiveHourBaselineTokens: number
  /** 週間枠ゲージの基準トークン数（分母） */
  weeklyBaselineTokens: number
  /** コストパネルを表示するか */
  showCost: boolean
  /** 常に最前面 */
  alwaysOnTop: boolean
  /** OS起動時に自動起動 */
  launchAtLogin: boolean
  /**
   * 公式 /usage 実データを使う（オプトイン・既定OFF）。
   * ON の場合 ~/.claude/.credentials.json のトークンで使用量エンドポイントを叩く。
   * 取得失敗時はローカル推定へ自動フォールバック。
   */
  useOfficialUsage: boolean
}

export const DEFAULT_SETTINGS: WidgetSettings = {
  fiveHourBaselineTokens: 85_000_000,
  weeklyBaselineTokens: 430_000_000,
  showCost: true,
  alwaysOnTop: true,
  launchAtLogin: true,
  useOfficialUsage: false
}

/** 空の集計 */
export function emptyAggregate(): WindowAggregate {
  return { byModel: {}, totalTokens: 0, messageCount: 0, costUSD: 0 }
}
