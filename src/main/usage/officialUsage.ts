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

// 診断ログ: 失敗は常に warn、詳細（本文・成功値）は CUW_DEBUG=1 のときだけ。
// trim(): cmd の `set VAR=1 && ...` 形式だと値に末尾スペースが入るため防御
const DEBUG = ['1', 'true'].includes((process.env.CUW_DEBUG ?? '').trim())
function dbg(...a: unknown[]): void {
  if (DEBUG) console.log('[official]', ...a)
}
function warn(...a: unknown[]): void {
  console.warn('[official]', ...a)
}

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

/** claude.ai のセッションCookie（sessionKey）があるか＝ログイン済みか */
async function hasSessionCookie(): Promise<boolean> {
  try {
    const cookies = await claudeSession().cookies.get({ url: ORIGIN })
    return cookies.some((c) => c.name === 'sessionKey' && !!c.value)
  } catch {
    return false
  }
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
  try {
    const cookies = await claudeSession().cookies.get({ url: ORIGIN })
    for (const name of ['lastActiveOrgId', 'lastActiveOrg', 'activeOrganizationUuid', 'orgUuid']) {
      const c = cookies.find((ck) => ck.name === name)
      if (c?.value) {
        dbg('orgId from cookie', name)
        return decodeURIComponent(c.value)
      }
    }
  } catch {
    /* fall through to API */
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
    seven_day_oauth_apps: '週(アプリ)'
  }
  if (known[key]) return known[key]
  // 一般化: <window>_<model> → 「<窓>(<Model>)」（例: seven_day_opus→週(Opus), seven_day_fable→週(Fable)）
  const win = key.includes('seven_day') ? '週' : key.includes('five_hour') ? '5時間' : ''
  const model = key.match(/(fable|mythos|opus|sonnet|haiku)/i)?.[1]
  if (win && model) {
    const m = model.charAt(0).toUpperCase() + model.slice(1).toLowerCase()
    return `${win}(${m})`
  }
  return key
    .replace(/seven_day/g, '週')
    .replace(/five_hour/g, '5時間')
    .replace(/_/g, ' ')
    .trim()
}

/** `utilization`(number) を持つオブジェクトか判定 */
function isUtilizationLeaf(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && typeof (v as any).utilization === 'number'
}

/** 配列要素のキーパス末尾セグメント。model/name/key の文字列フィールドがあればそれを使い、無ければ添字 */
function arrayElementLabelSegment(el: Record<string, any>, index: number): string {
  const v = el.model ?? el.name ?? el.key
  return typeof v === 'string' && v ? v : String(index)
}

/**
 * `utilization` を持つオブジェクトを再帰的に探索し extras 候補を集める。
 * `depthLeft` は「現在のノードの子（またはその配列要素）を検査してよい残り階層数」。
 * 呼び出し元で depthLeft=1 を渡すと、このノード自身の子を検査する（＝深さ2）のみ許可し、
 * その子がさらに非leafでもそこから先（深さ3）へは descend しない。
 * five_hour/seven_day 相当や、既に extras として拾ったオブジェクトの子は二重に探索しない
 * （utilization leaf を見つけた時点でその配下へは descend しない）。
 */
function walkForExtras(node: unknown, path: string[], depthLeft: number, out: LabeledLimit[]): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((el, idx) => {
      if (isUtilizationLeaf(el)) {
        const lim = toLimit(el)
        if (lim) out.push({ label: labelFor([...path, arrayElementLabelSegment(el, idx)].join('_')), limit: lim })
        return
      }
      if (depthLeft > 1) walkForExtras(el, path, depthLeft - 1, out)
    })
    return
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (isUtilizationLeaf(v)) {
      const lim = toLimit(v)
      if (lim) out.push({ label: labelFor([...path, k].join('_')), limit: lim })
      continue
    }
    if (depthLeft > 1) walkForExtras(v, [...path, k], depthLeft - 1, out)
  }
}

/**
 * レスポンスを UsageLimits に変換。five_hour/seven_day は必須トップレベル、
 * その他の `utilization` を持つキーは extras（例: 週(Opus)）として拾う。
 * トップレベルキー自体が `utilization` を持つ従来のフラット形状（例: seven_day_opus）に加え、
 * `{ model_limits: { fable: { utilization } } }` のようなネストや、
 * `[{ model: 'fable', utilization, resets_at }]` のような配列も**深さ2まで**再帰的に探索する。
 * 実レスポンス形状は未検証のため防御的に処理する。
 */
export function mapUsage(data: any): UsageLimits | null {
  if (!data || typeof data !== 'object') return null
  dbg('response top-level keys:', Object.keys(data))
  const five = toLimit(data.five_hour)
  const week = toLimit(data.seven_day)
  if (!five || !week) return null
  const extras: LabeledLimit[] = []
  for (const [key, val] of Object.entries(data)) {
    if (key === 'five_hour' || key === 'seven_day') continue
    const lim = toLimit(val)
    if (lim) {
      // フラット形状: このキー自体が utilization leaf → 子は探索しない
      extras.push({ label: labelFor(key), limit: lim })
      continue
    }
    // ネスト/配列形状: この階層(1)+1階層=深さ2まで utilization leaf を探索
    walkForExtras(val, [key], 1, extras)
  }
  dbg(
    'extras collected:',
    extras.map((e) => e.label)
  )
  return { fiveHour: five, weekly: week, extras: extras.length ? extras : undefined }
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
