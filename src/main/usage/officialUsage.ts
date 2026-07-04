import { session as electronSession, net, BrowserWindow } from 'electron'
import type { LabeledLimit, PlanLimit, UsageLimits } from '../../shared/types'

/**
 * 公式 /usage 実データ（オプトイン）。
 *
 * 方式（https://zenn.dev/nihondo/articles/af972fa985f5ac を参考）:
 *   - エンドポイント: GET https://claude.ai/api/organizations/{orgId}/usage
 *   - 認証: claude.ai の**セッションCookie**（API の OAuth トークンではない）
 *   - orgId: Cookie `lastActiveOrgId` から取得
 *   - レスポンス: { five_hour:{utilization,resets_at}, seven_day:{utilization,resets_at} }
 *     （utilization は 0..100 のパーセント）
 *
 * Cookie は Electron の永続パーティションに保持し、ユーザーは専用ウィンドウで
 * claude.ai に一度ログインする。以降はそのセッションで自動的に Cookie が付く。
 * ⚠️ 非公開 Web API。claude.ai 側の仕様変更で動かなくなる可能性あり（その場合は
 * ローカル推定へ自動フォールバック）。
 */

const PARTITION = 'persist:claudeai'
const ORIGIN = process.env.CUW_USAGE_ORIGIN || 'https://claude.ai'
// 一部サイトは "Electron" UA を弾くため、通常の Chrome UA を名乗る
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

let loginWindow: BrowserWindow | null = null

function claudeSession(): Electron.Session {
  return electronSession.fromPartition(PARTITION)
}

/** claude.ai にログイン済みか（セッションCookieの有無で判定） */
export async function isClaudeLoggedIn(): Promise<boolean> {
  try {
    const cookies = await claudeSession().cookies.get({ url: ORIGIN })
    return cookies.some((c) => c.name === 'sessionKey' || c.name === 'lastActiveOrgId')
  } catch {
    return false
  }
}

/** claude.ai ログイン用ウィンドウを開く（永続パーティションに Cookie を保存） */
export function openClaudeLogin(): void {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus()
    return
  }
  loginWindow = new BrowserWindow({
    width: 460,
    height: 760,
    title: 'claude.ai ログイン',
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  loginWindow.on('closed', () => {
    loginWindow = null
    clearOfficialCache() // ログイン直後は次の tick で即再取得させる
  })
  void loginWindow.loadURL(`${ORIGIN}/login`, { userAgent: UA })
}

/** Cookie から組織ID（lastActiveOrgId）を取得 */
async function getOrgId(): Promise<string | null> {
  try {
    const cookies = await claudeSession().cookies.get({ url: ORIGIN })
    const org = cookies.find((c) => c.name === 'lastActiveOrgId')
    return org?.value ? decodeURIComponent(org.value) : null
  } catch {
    return null
  }
}

/** five_hour / seven_day の1枠を PlanLimit に変換 */
function toLimit(w: any): PlanLimit | null {
  if (!w || typeof w.utilization !== 'number') return null
  const fraction = Math.max(0, Math.min(1, w.utilization / 100))
  const reset = w.resets_at ?? w.resetsAt ?? null
  let iso: string | null = null
  if (typeof reset === 'string') {
    const t = Date.parse(reset)
    iso = Number.isNaN(t) ? null : new Date(t).toISOString()
  }
  return { windowTokens: 0, baselineTokens: 0, fraction, windowResetsAt: iso, source: 'official' }
}

/** 追加枠のキー名を日本語ラベルへ（未知キーは整形して表示） */
function labelFor(key: string): string {
  const known: Record<string, string> = {
    seven_day_opus: '週(Opus)',
    seven_day_oauth_apps: '週(アプリ)',
    five_hour_opus: '5時間(Opus)'
  }
  if (known[key]) return known[key]
  return key
    .replace(/seven_day/g, '週')
    .replace(/five_hour/g, '5時間')
    .replace(/_/g, ' ')
    .replace(/opus/gi, 'Opus')
    .trim()
}

/**
 * レスポンスを UsageLimits に変換。five_hour/seven_day は必須、
 * その他の `utilization` を持つキーは extras（例: 週(Opus)）として拾う。
 * 実レスポンス形状は未検証のため防御的に処理する。
 */
function mapUsage(data: any): UsageLimits | null {
  if (!data || typeof data !== 'object') return null
  const five = toLimit(data.five_hour)
  const week = toLimit(data.seven_day)
  if (!five || !week) return null
  const extras: LabeledLimit[] = []
  for (const [key, val] of Object.entries(data)) {
    if (key === 'five_hour' || key === 'seven_day') continue
    const lim = toLimit(val)
    if (lim) extras.push({ label: labelFor(key), limit: lim })
  }
  return { fiveHour: five, weekly: week, extras: extras.length ? extras : undefined }
}

/** claude.ai の usage エンドポイントをセッションCookie付きで叩く */
function requestUsage(orgId: string, timeoutMs: number): Promise<UsageLimits | null> {
  return new Promise((resolve) => {
    const req = net.request({
      method: 'GET',
      url: `${ORIGIN}/api/organizations/${orgId}/usage`,
      session: claudeSession(),
      useSessionCookies: true
    })
    req.setHeader('Accept', 'application/json')
    req.setHeader('User-Agent', UA)
    const timer = setTimeout(() => {
      try {
        req.abort()
      } catch {
        /* noop */
      }
      resolve(null)
    }, timeoutMs)
    let body = ''
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer)
        res.on('data', () => {})
        res.on('end', () => resolve(null))
        return
      }
      res.on('data', (chunk) => (body += chunk.toString()))
      res.on('end', () => {
        clearTimeout(timer)
        try {
          resolve(mapUsage(JSON.parse(body)))
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    req.end()
  })
}

// 成功結果は 60 秒キャッシュ（クラウド既定ONだと tick 毎に呼ばれるため claude.ai を叩きすぎない）
let cache: { at: number; value: UsageLimits } | null = null
const CACHE_MS = 60_000

/** 公式使用量を取得。未ログイン・失敗時は null（呼び出し側はローカル推定を使う）。 */
export async function fetchOfficialLimits(timeoutMs = 6000): Promise<UsageLimits | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value
  const orgId = await getOrgId()
  if (!orgId) return null // 未ログイン: ネットワーク呼び出しなし
  const value = await requestUsage(orgId, timeoutMs)
  if (value) cache = { at: Date.now(), value }
  return value
}

/** キャッシュを破棄（ログイン直後などに即再取得したいとき） */
export function clearOfficialCache(): void {
  cache = null
}
