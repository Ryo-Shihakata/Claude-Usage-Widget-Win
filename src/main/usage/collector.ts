import { homedir } from 'os'
import { join } from 'path'
import { promises as fs } from 'fs'
import {
  emptyAggregate,
  type ModelTokens,
  type PlanLimit,
  type UsageSnapshot,
  type WidgetSettings,
  type WindowAggregate
} from '../../shared/types'
import { estimateCost } from './pricing'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const FIVE_HOURS = 5 * HOUR

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

export class UsageCollector {
  private records: UsageRecord[] = []
  private offsets = new Map<string, number>()
  private seenIds = new Set<string>()
  private projectsDir: string

  constructor(baseDir?: string) {
    this.projectsDir = join(baseDir ?? defaultClaudeDir(), 'projects')
  }

  /** projects 配下の全 *.jsonl を列挙 */
  private async listJsonlFiles(): Promise<string[]> {
    const out: string[] = []
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(this.projectsDir, { withFileTypes: true })
    } catch {
      return out
    }
    for (const dir of entries) {
      if (!dir.isDirectory()) continue
      const sub = join(this.projectsDir, dir.name)
      let files: import('fs').Dirent[]
      try {
        files = await fs.readdir(sub, { withFileTypes: true })
      } catch {
        continue
      }
      for (const f of files) {
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
      const offset = this.offsets.get(file) ?? 0
      const { lines, newOffset } = await readNewLines(file, offset)
      this.offsets.set(file, newOffset)
      if (lines.length === 0) continue
      const sessionId = file.slice(file.lastIndexOf('/') + 1).replace(/\.jsonl$/, '')
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
    const cutoff = Date.now() - 7 * DAY
    if (this.records.length === 0) return
    const kept: UsageRecord[] = []
    for (const r of this.records) {
      if (r.ts >= cutoff) kept.push(r)
      else this.seenIds.delete(r.id)
    }
    this.records = kept
  }

  private aggregate(records: UsageRecord[]): WindowAggregate {
    const agg = emptyAggregate()
    for (const r of records) {
      let m = agg.byModel[r.model]
      if (!m) {
        m = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
        agg.byModel[r.model] = m
      }
      m.inputTokens += r.input
      m.outputTokens += r.output
      m.cacheCreationTokens += r.cacheCreate
      m.cacheReadTokens += r.cacheRead
      agg.totalTokens += r.input + r.output + r.cacheCreate + r.cacheRead
      agg.messageCount += 1
    }
    for (const [model, t] of Object.entries(agg.byModel)) {
      agg.costUSD += estimateCost(model, t as ModelTokens)
    }
    return agg
  }

  /** 現在のレコードから表示用スナップショットを生成 */
  buildSnapshot(settings: WidgetSettings, found = true): UsageSnapshot {
    const now = Date.now()
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    const todayStart = midnight.getTime()
    const fiveHAgo = now - FIVE_HOURS
    const sevenDAgo = now - 7 * DAY

    const todayRecs = this.records.filter((r) => r.ts >= todayStart)
    const last5hRecs = this.records.filter((r) => r.ts >= fiveHAgo)
    const last7dRecs = this.records.filter((r) => r.ts >= sevenDAgo)

    const sessions = new Set(todayRecs.map((r) => r.sessionId))

    const last5h = this.aggregate(last5hRecs)
    const last7d = this.aggregate(last7dRecs)

    return {
      generatedAt: new Date(now).toISOString(),
      today: this.aggregate(todayRecs),
      last5h,
      last7d,
      limits: {
        fiveHour: buildLimit(
          last5h.totalTokens,
          settings.fiveHourBaselineTokens,
          last5hRecs,
          FIVE_HOURS
        ),
        weekly: buildLimit(
          last7d.totalTokens,
          settings.weeklyBaselineTokens,
          last7dRecs,
          7 * DAY
        )
      },
      sessionCount: sessions.size,
      status: found ? null : 'Claude Code のデータが見つかりません'
    }
  }
}

/** 枠の消費量・基準・最古レコードから PlanLimit を作る */
function buildLimit(
  windowTokens: number,
  baselineRaw: number,
  recs: { ts: number }[],
  windowMs: number
): PlanLimit {
  const baseline = Math.max(1, baselineRaw)
  const oldest = recs.reduce((min, r) => Math.min(min, r.ts), Infinity)
  return {
    windowTokens,
    baselineTokens: baseline,
    fraction: Math.min(1, windowTokens / baseline),
    windowResetsAt: Number.isFinite(oldest) ? new Date(oldest + windowMs).toISOString() : null
  }
}
