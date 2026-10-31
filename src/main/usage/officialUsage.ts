import { session as electronSession, net, BrowserWindow } from 'electron'
import type { UsageLimits } from '../../shared/types'
import { mapUsage } from './officialParse'
import { DEBUG, dbg, warn } from './officialLog'

/**
 * 公式 /usage 実データ（既定ON。設定で無効化可）。
 *
 * 方式（https://zenn.dev/nihondo/articles/af972fa985f5ac を参考）:
 *   - エンドポイント: GET https://claude.ai/api/organizations/{orgId}/usage
 *   - 認証: claude.ai の**セッションCookie**（API の OAuth トークンではない）
 *   - orgId: Cookie `lastActiveOrgId` 等、無ければ `/api/organizations` から取得
 *   - レスポンス: { five_hour:{utilization,resets_at}, seven_day:{utilization,resets_at}, ... }
 *     （utilization は 0..100 のパーセント。解析は officialParse.ts）
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

/** claude.ai の Cookie 一覧。読めなければ空配列 */
async function getCookies(): Promise<Electron.Cookie[]> {
  try {
    return await claudeSession().cookies.get({ url: ORIGIN })
  } catch {
    return []
  }
}

/** claude.ai にログイン済みか（セッションCookieの有無で判定） */
export async function isClaudeLoggedIn(): Promise<boolean> {
  const cookies = await getCookies()
  return cookies.some((c) => c.name === 'sessionKey' || c.name === 'lastActiveOrgId')
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

/** claude.ai のセッションCookie（sessionKey）があるか＝ログイン済みか */
async function hasSessionCookie(): Promise<boolean> {
  const cookies = await getCookies()
  return cookies.some((c) => c.name === 'sessionKey' && !!c.value)
}

/** claude.ai への GET（セッションCookie付き）。{status, json} を返す。到達不能なら null。 */
function requestJson(
  path: string,
  timeoutMs: number
): Promise<{ status: number; json: any } | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: { status: number; json: any } | null): void => {
      if (settled) return
      settled = true
      resolve(v)
    }
    let req: Electron.ClientRequest
    try {
      req = net.request({
        method: 'GET',
        url: `${ORIGIN}${path}`,
        session: claudeSession(),
        useSessionCookies: true
      })
    } catch (e) {
      warn('request 構築失敗', path, String(e))
      return done(null)
    }
    req.setHeader('Accept', 'application/json')
    req.setHeader('User-Agent', UA)
    req.setHeader('Referer', `${ORIGIN}/`)
    const timer = setTimeout(() => {
      try {
        req.abort()
      } catch {
        /* noop */
      }
      warn('timeout', path)
      done(null)
    }, timeoutMs)
    let body = ''
    req.on('response', (res) => {
      const status = res.statusCode
      res.on('data', (c) => (body += c.toString()))
      res.on('end', () => {
        clearTimeout(timer)
        if (status !== 200) {
          warn(`GET ${path} -> HTTP ${status}`, DEBUG ? body.slice(0, 400) : '(CUW_DEBUG=1で本文表示)')
          return done({ status, json: null })
        }
        try {
          done({ status, json: JSON.parse(body) })
        } catch {
          warn(`GET ${path} -> 200 だが JSON parse 失敗`, DEBUG ? body.slice(0, 400) : '')
          done({ status, json: null })
        }
      })
    })
    req.on('error', (e) => {
      clearTimeout(timer)
      warn('network error', path, String(e))
      done(null)
    })
    req.end()
  })
}

/**
 * 組織IDを取得。①Cookie の候補名を試し、②無ければ組織一覧API `/api/organizations` から取得。
 * Cookie 名は claude.ai 側で変わり得るため、API フォールバックを本命とする。
 */
async function getOrgId(timeoutMs: number): Promise<string | null> {
  // 1. Cookie 候補
  const cookies = await getCookies()
  for (const name of ['lastActiveOrgId', 'lastActiveOrg', 'activeOrganizationUuid', 'orgUuid']) {
    const c = cookies.find((ck) => ck.name === name)
    if (c?.value) {
      dbg('orgId from cookie', name)
      return decodeURIComponent(c.value)
    }
  }
  // 2. 組織一覧API
  const res = await requestJson('/api/organizations', timeoutMs)
  const list = res?.json
  if (Array.isArray(list) && list.length > 0) {
    const id = list[0]?.uuid ?? list[0]?.id
    if (typeof id === 'string' && id) {
      dbg('orgId from /api/organizations')
      return id
    }
    warn('/api/organizations は配列だが uuid/id が無い', DEBUG ? JSON.stringify(list).slice(0, 300) : '')
  } else {
    warn('orgId 取得失敗', res ? `orgs HTTP=${res.status}` : '応答なし')
  }
  return null
}

/** usage エンドポイントを叩いて UsageLimits に変換 */
async function fetchUsage(orgId: string, timeoutMs: number): Promise<UsageLimits | null> {
  const res = await requestJson(`/api/organizations/${orgId}/usage`, timeoutMs)
  if (!res || res.json == null) return null
  const mapped = mapUsage(res.json)
  if (!mapped) {
    warn(
      'usage は取得できたが five_hour/seven_day を認識できず',
      DEBUG ? JSON.stringify(res.json).slice(0, 500) : '(CUW_DEBUG=1で本文表示。キー名を教えてください)'
    )
  } else {
    dbg(
      'usage OK',
      `5h=${Math.round(mapped.fiveHour.fraction * 100)}%`,
      `week=${Math.round(mapped.weekly.fraction * 100)}%`,
      `extras=${mapped.extras?.length ?? 0}`
    )
  }
  return mapped
}

// 成功結果は 60 秒キャッシュ（クラウド既定ONだと tick 毎に呼ばれるため claude.ai を叩きすぎない）
let cache: { at: number; value: UsageLimits } | null = null
const CACHE_MS = 60_000

/** 公式使用量を取得。未ログイン・失敗時は null（呼び出し側はローカル推定を使う）。 */
export async function fetchOfficialLimits(timeoutMs = 6000): Promise<UsageLimits | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value
  if (!(await hasSessionCookie())) {
    dbg('未ログイン（sessionKey Cookie 無し）→ ローカル推定')
    return null // 未ログイン: ネットワーク呼び出しなし
  }
  const orgId = await getOrgId(timeoutMs)
  if (!orgId) return null // 失敗理由は getOrgId 内で warn 済み
  const value = await fetchUsage(orgId, timeoutMs)
  if (value) cache = { at: Date.now(), value }
  return value
}

/** キャッシュを破棄（ログイン直後などに即再取得したいとき） */
export function clearOfficialCache(): void {
  cache = null
}
