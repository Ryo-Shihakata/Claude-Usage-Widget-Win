import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { UsageCollector } from '../src/main/usage/collector'
import { DEFAULT_SETTINGS } from '../src/shared/types'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function line(o: {
  id: string
  ts: number
  model: string
  input?: number
  output?: number
  cw?: number
  cr?: number
}): string {
  return (
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(o.ts).toISOString(),
      message: {
        id: o.id,
        model: o.model,
        usage: {
          input_tokens: o.input ?? 0,
          output_tokens: o.output ?? 0,
          cache_creation_input_tokens: o.cw ?? 0,
          cache_read_input_tokens: o.cr ?? 0
        }
      }
    }) + '\n'
  )
}

function setup(): { base: string; dir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'cuw-test-'))
  const dir = join(base, 'projects', 'proj-a')
  mkdirSync(dir, { recursive: true })
  return { base, dir, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

test('データディレクトリが無ければ found=false とステータスを返す', async () => {
  const base = mkdtempSync(join(tmpdir(), 'cuw-test-'))
  try {
    const c = new UsageCollector(base)
    const { found } = await c.refresh()
    assert.equal(found, false)
    const snap = c.buildSnapshot(DEFAULT_SETTINGS, found)
    assert.equal(snap.status, 'Claude Code のデータが見つかりません')
    assert.equal(snap.daily.length, 7)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('今日・5h・7d の集計、セッション数、Fable 枠、日毎グラフ', async () => {
  const { base, dir, cleanup } = setup()
  try {
    const now = Date.now()
    writeFileSync(
      join(dir, 's1.jsonl'),
      line({ id: 'a', ts: now - 1 * MIN, model: 'claude-opus-4-8', input: 100, output: 50, cw: 10, cr: 1000 }) +
        line({ id: 'b', ts: now - 2 * MIN, model: 'claude-fable-5', input: 1000, output: 500 }) +
        // 重複 ID は1回だけ数える
        line({ id: 'b', ts: now - 2 * MIN, model: 'claude-fable-5', input: 1000, output: 500 }) +
        // usage の無い行・壊れた行・user 行は無視
        JSON.stringify({ type: 'user', timestamp: new Date(now).toISOString() }) +
        '\n{broken json\n'
    )
    writeFileSync(
      join(dir, 's2.jsonl'),
      line({ id: 'c', ts: now - 3 * DAY, model: 'claude-sonnet-4-6', input: 7, output: 3 }) +
        // 7日より前は捨てる
        line({ id: 'd', ts: now - 8 * DAY, model: 'claude-sonnet-4-6', input: 999, output: 999 })
    )
    const c = new UsageCollector(base)
    const { found } = await c.refresh()
    assert.equal(found, true)
    const snap = c.buildSnapshot(DEFAULT_SETTINGS, found)

    assert.equal(snap.status, null)
    assert.equal(snap.today.messageCount, 2)
    assert.equal(snap.today.totalTokens, 100 + 50 + 10 + 1000 + 1500)
    assert.deepEqual(snap.today.byModel['claude-opus-4-8'], {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 10,
      cacheReadTokens: 1000
    })
    assert.equal(snap.sessionCount, 1)
    assert.equal(snap.last5h.totalTokens, snap.today.totalTokens)
    assert.equal(snap.last7d.totalTokens, snap.today.totalTokens + 10)
    assert.equal(snap.last7d.messageCount, 3)

    // コスト: opus(5/25/0.5/6.25) + fable(10/50) を MTok 単価で
    const expectedToday =
      (100 * 5 + 50 * 25 + 1000 * 0.5 + 10 * 6.25) / 1e6 + (1000 * 10 + 500 * 50) / 1e6
    assert.ok(Math.abs(snap.today.costUSD - expectedToday) < 1e-12)

    const f5 = snap.limits.fiveHour
    assert.equal(f5.source, 'local')
    assert.equal(f5.windowTokens, snap.last5h.totalTokens)
    assert.equal(f5.baselineTokens, DEFAULT_SETTINGS.fiveHourBaselineTokens)
    assert.equal(f5.fraction, snap.last5h.totalTokens / DEFAULT_SETTINGS.fiveHourBaselineTokens)
    // 枠内で最も古いレコード + 枠長
    assert.equal(f5.windowResetsAt, new Date(now - 2 * MIN + 5 * HOUR).toISOString())
    assert.equal(snap.limits.weekly.windowResetsAt, new Date(now - 3 * DAY + 7 * DAY).toISOString())

    assert.equal(snap.limits.extras?.length, 1)
    assert.equal(snap.limits.extras?.[0].label, '週(Fable)')
    assert.equal(snap.limits.extras?.[0].limit.windowTokens, 1500)
    assert.equal(
      snap.limits.extras?.[0].limit.baselineTokens,
      DEFAULT_SETTINGS.fableWeeklyBaselineTokens
    )

    assert.equal(snap.daily.length, 7)
    assert.equal(snap.daily[6].tokens, snap.today.totalTokens)
    assert.equal(
      snap.daily.reduce((s, d) => s + d.tokens, 0),
      snap.last7d.totalTokens
    )
    assert.match(snap.daily[0].date, /^\d{4}-\d{2}-\d{2}$/)

    // showFableWeekly=false なら Fable 枠を出さない
    const off = c.buildSnapshot({ ...DEFAULT_SETTINGS, showFableWeekly: false }, true)
    assert.equal(off.limits.extras, undefined)
  } finally {
    cleanup()
  }
})

test('追記分だけを読み、未完の末尾行は次回に回す', async () => {
  const { base, dir, cleanup } = setup()
  try {
    const now = Date.now()
    const file = join(dir, 's1.jsonl')
    writeFileSync(file, line({ id: 'a', ts: now - MIN, model: 'claude-haiku-4-5', input: 1 }))
    const c = new UsageCollector(base)
    await c.refresh()
    assert.equal(c.buildSnapshot(DEFAULT_SETTINGS).today.messageCount, 1)

    const next = line({ id: 'b', ts: now - MIN, model: 'claude-haiku-4-5', input: 2 })
    appendFileSync(file, next.slice(0, 20)) // 書きかけ
    await c.refresh()
    assert.equal(c.buildSnapshot(DEFAULT_SETTINGS).today.messageCount, 1)

    appendFileSync(file, next.slice(20))
    await c.refresh()
    const snap = c.buildSnapshot(DEFAULT_SETTINGS)
    assert.equal(snap.today.messageCount, 2)
    assert.equal(snap.today.totalTokens, 3)
  } finally {
    cleanup()
  }
})
