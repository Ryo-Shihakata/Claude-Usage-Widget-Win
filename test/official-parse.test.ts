import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapUsage } from '../src/main/usage/officialParse'

const leaf = (u: number, r: string | null = '2026-11-01T00:00:00Z') => ({
  utilization: u,
  resets_at: r
})

test('five_hour / seven_day が無ければ null', () => {
  assert.equal(mapUsage(null), null)
  assert.equal(mapUsage({}), null)
  assert.equal(mapUsage({ five_hour: leaf(10) }), null)
  assert.equal(mapUsage({ five_hour: leaf(10), seven_day: { utilization: '5' } }), null)
})

test('フラット形状: 5h/週間と機種別 extras を拾う', () => {
  const r = mapUsage({
    five_hour: leaf(42),
    seven_day: leaf(150, 'invalid'),
    seven_day_opus: leaf(10),
    seven_day_fable: leaf(20),
    seven_day_oauth_apps: leaf(30),
    seven_day_sonnet: null,
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: 0, utilization: null }
  })
  assert.ok(r)
  assert.equal(r.fiveHour.fraction, 0.42)
  assert.equal(r.fiveHour.source, 'official')
  assert.equal(r.fiveHour.windowResetsAt, '2026-11-01T00:00:00.000Z')
  assert.equal(r.weekly.fraction, 1) // クランプ
  assert.equal(r.weekly.windowResetsAt, null)
  assert.deepEqual(
    r.extras?.map((e) => [e.label, e.limit.fraction]),
    [
      ['週(Opus)', 0.1],
      ['週(Fable)', 0.2],
      ['週(アプリ)', 0.3]
    ]
  )
})

test('ネスト・配列形状は深さ2まで探索する', () => {
  const r = mapUsage({
    five_hour: leaf(0),
    seven_day: leaf(0),
    model_limits: { seven_day_mythos: leaf(5), deeper: { too: { deep: leaf(1) } } },
    seven_day_models: [{ model: 'haiku', ...leaf(7) }, { ...leaf(8) }]
  })
  assert.deepEqual(
    r?.extras?.map((e) => e.label),
    ['週(Mythos)', '週(Haiku)', '週 models 1']
  )
})

test('extras が無ければ undefined', () => {
  const r = mapUsage({ five_hour: leaf(1), seven_day: leaf(2) })
  assert.equal(r?.extras, undefined)
})
