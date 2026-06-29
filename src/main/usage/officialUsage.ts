import { session as electronSession, net, BrowserWindow } from 'electron'
import type { PlanLimit, UsageLimits } from '../../shared/types'

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

function mapUsage(data: any): UsageLimits | null {
  const five = toLimit(data?.five_hour)
  const week = toLimit(data?.seven_day)
  if (!five || !week) return null
  return { fiveHour: five, weekly: week }
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

/** 公式使用量を取得。未ログイン・失敗時は null（呼び出し側はローカル推定を使う）。 */
export async function fetchOfficialLimits(timeoutMs = 6000): Promise<UsageLimits | null> {
  const orgId = await getOrgId()
  if (!orgId) return null
  return requestUsage(orgId, timeoutMs)
}
