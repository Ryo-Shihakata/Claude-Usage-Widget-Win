import { homedir } from 'os'
import { basename, join } from 'path'
import { promises as fs, type Dirent } from 'fs'
import {
  emptyAggregate,
  type DailyUsage,
  type PlanLimit,
  type UsageLimits,
  type UsageSnapshot,
  type WidgetSettings,
  type WindowAggregate
} from '../../shared/types'
import { isFableFamily } from '../../shared/usage'
import { estimateCost } from './pricing'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const FIVE_HOURS = 5 * HOUR
const SEVEN_DAYS = 7 * DAY

/** assistant 応答1件分の軽量レコード */
interface UsageRecord {
  id: string
  ts: number // epoch ms
  model: string
  sessionId: string
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
}

function recordTokens(r: UsageRecord): number {
  return r.input + r.output + r.cacheCreate + r.cacheRead
}

/** Claude Code のデータディレクトリ（CLAUDE_CONFIG_DIR 環境変数を尊重） */
export function defaultClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/** ファイル末尾の追記分のみを行単位で読む（完全な行だけを返し、未完の末尾行はオフセットを進めない） */
async function readNewLines(
  path: string,
  offset: number
): Promise<{ lines: string[]; newOffset: number }> {
  let size: number
  try {
    size = (await fs.stat(path)).size
  } catch {
    return { lines: [], newOffset: offset }
  }
  // ファイルがローテーション等で縮んだ場合は先頭から読み直す
  if (size < offset) offset = 0
  if (size <= offset) return { lines: [], newOffset: offset }

  const fh = await fs.open(path, 'r')
  try {
    const length = size - offset
    const buf = Buffer.allocUnsafe(length)
    await fh.read(buf, 0, length, offset)
    const lastNl = buf.lastIndexOf(0x0a) // '\n'
    if (lastNl < 0) return { lines: [], newOffset: offset } // 完全な行がまだ無い
    const complete = buf.subarray(0, lastNl).toString('utf8')
    const lines = complete.length ? complete.split('\n') : []
    return { lines, newOffset: offset + lastNl + 1 }
  } finally {
    await fh.close()
  }
}

/** 1行（JSON）を UsageRecord に変換。usage を持つ assistant 行でなければ null。 */
function parseLine(line: string, sessionId: string): UsageRecord | null {
  if (!line) return null
  let obj: any
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }
  if (obj?.type !== 'assistant') return null
  const msg = obj.message
  const usage = msg?.usage
  if (!usage || !msg?.model) return null
  const ts = Date.parse(obj.timestamp)
  if (Number.isNaN(ts)) return null
  return {
    id: String(msg.id ?? obj.uuid ?? `${sessionId}:${ts}`),
    ts,
    model: String(msg.model),
    sessionId,
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheCreate: usage.cache_creation_input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0
  }
}

/** 読めないディレクトリは空として扱う */
async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** ローカル日付 'YYYY-MM-DD' */
function localDateKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function aggregate(records: UsageRecord[]): WindowAggregate {
  const agg = emptyAggregate()
  for (const r of records) {
    const m = (agg.byModel[r.model] ??= {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0
    })
    m.inputTokens += r.input
    m.outputTokens += r.output
    m.cacheCreationTokens += r.cacheCreate
    m.cacheReadTokens += r.cacheRead
    agg.totalTokens += recordTokens(r)
    agg.messageCount += 1
  }
  for (const [model, t] of Object.entries(agg.byModel)) {
    agg.costUSD += estimateCost(model, t)
  }
  return agg
}

/** 枠内レコードと基準値から PlanLimit を作る。リセット目安は枠内で最も古いレコード + 枠長 */
function buildLimit(recs: UsageRecord[], baselineRaw: number, windowMs: number): PlanLimit {
  const windowTokens = recs.reduce((s, r) => s + recordTokens(r), 0)
  const baseline = Math.max(1, baselineRaw)
  const oldest = recs.reduce((min, r) => Math.min(min, r.ts), Infinity)
  return {
    windowTokens,
    baselineTokens: baseline,
    fraction: Math.min(1, windowTokens / baseline),
    windowResetsAt: Number.isFinite(oldest) ? new Date(oldest + windowMs).toISOString() : null,
    source: 'local'
  }
}

/** 今日を末尾とする直近7日の日毎トークン（ローカル日境界、使用0の日も含め常に7要素） */
function buildDaily(records: UsageRecord[], todayStart: number): DailyUsage[] {
  const firstStart = todayStart - 6 * DAY
  const tokens = new Array<number>(7).fill(0)
  for (const r of records) {
    const i = Math.floor((r.ts - firstStart) / DAY)
    if (i >= 0 && i < 7) tokens[i] += recordTokens(r)
  }
  return tokens.map((t, i) => ({ date: localDateKey(firstStart + i * DAY), tokens: t }))
}

export class UsageCollector {
  private records: UsageRecord[] = []
  private offsets = new Map<string, number>()
  private seenIds = new Set<string>()
  readonly projectsDir: string

  constructor(baseDir?: string) {
    this.projectsDir = join(baseDir ?? defaultClaudeDir(), 'projects')
  }

  /** projects/<project>/*.jsonl を列挙 */
  private async listJsonlFiles(): Promise<string[]> {
    const out: string[] = []
    for (const dir of await readDirSafe(this.projectsDir)) {
      if (!dir.isDirectory()) continue
      const sub = join(this.projectsDir, dir.name)
      for (const f of await readDirSafe(sub)) {
        if (f.isFile() && f.name.endsWith('.jsonl')) out.push(join(sub, f.name))
      }
    }
    return out
  }

  /** ファイルを走査し、追記された assistant usage 行を取り込む。データディレクトリの有無を返す。 */
  async refresh(): Promise<{ found: boolean }> {
    const files = await this.listJsonlFiles()
    if (files.length === 0) {
      // projects ディレクトリ自体の有無で found を判定
      try {
        await fs.access(this.projectsDir)
        return { found: true }
      } catch {
        return { found: false }
      }
    }
    for (const file of files) {
      const { lines, newOffset } = await readNewLines(file, this.offsets.get(file) ?? 0)
      this.offsets.set(file, newOffset)
      const sessionId = basename(file, '.jsonl')
      for (const line of lines) {
        const rec = parseLine(line, sessionId)
        if (!rec || this.seenIds.has(rec.id)) continue
        this.seenIds.add(rec.id)
        this.records.push(rec)
      }
    }
    this.prune()
    return { found: true }
  }

  /** 7日より古いレコードを破棄（メモリ上限を保つ） */
  private prune(): void {
    const cutoff = Date.now() - SEVEN_DAYS
    const kept: UsageRecord[] = []
    for (const r of this.records) {
      if (r.ts >= cutoff) kept.push(r)
      else this.seenIds.delete(r.id)
    }
    this.records = kept
  }

  /** 現在のレコードから表示用スナップショットを生成 */
  buildSnapshot(settings: WidgetSettings, found = true): UsageSnapshot {
    const now = Date.now()
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    const todayStart = midnight.getTime()

    const todayRecs = this.records.filter((r) => r.ts >= todayStart)
    const last5hRecs = this.records.filter((r) => r.ts >= now - FIVE_HOURS)
    const last7dRecs = this.records.filter((r) => r.ts >= now - SEVEN_DAYS)

    const limits: UsageLimits = {
      fiveHour: buildLimit(last5hRecs, settings.fiveHourBaselineTokens, FIVE_HOURS),
      weekly: buildLimit(last7dRecs, settings.weeklyBaselineTokens, SEVEN_DAYS)
    }

    // Fable/Mythos 専用の週間枠（ローカル推定）。設定ONかつ Fable 使用があるときだけ追加。
    if (settings.showFableWeekly) {
      const fableRecs = last7dRecs.filter((r) => isFableFamily(r.model))
      if (fableRecs.length > 0) {
        limits.extras = [
          {
            label: '週(Fable)',
            limit: buildLimit(fableRecs, settings.fableWeeklyBaselineTokens, SEVEN_DAYS)
          }
        ]
      }
    }

    return {
      generatedAt: new Date(now).toISOString(),
      today: aggregate(todayRecs),
      last5h: aggregate(last5hRecs),
      last7d: aggregate(last7dRecs),
      limits,
      daily: buildDaily(this.records, todayStart),
      sessionCount: new Set(todayRecs.map((r) => r.sessionId)).size,
      status: found ? null : 'Claude Code のデータが見つかりません'
    }
  }
}
