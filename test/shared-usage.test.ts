import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clamp01,
  isFableFamily,
  isOfficialLimits,
  modelFamily,
  sumTokens,
  usageLevel
} from '../src/shared/usage'
import type { PlanLimit } from '../src/shared/types'

const plan = (source: PlanLimit['source']): PlanLimit => ({
  windowTokens: 0,
  baselineTokens: 0,
  fraction: 0,
  windowResetsAt: null,
  source
})

test('sumTokens / clamp01', () => {
  assert.equal(
    sumTokens({ inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4 }),
    10
  )
  assert.equal(clamp01(-0.1), 0)
  assert.equal(clamp01(0.3), 0.3)
  assert.equal(clamp01(1.2), 1)
})

test('usageLevel の境界', () => {
  assert.equal(usageLevel(0.69), 'ok')
  assert.equal(usageLevel(0.7), 'warn')
  assert.equal(usageLevel(0.89), 'warn')
  assert.equal(usageLevel(0.9), 'danger')
})

test('modelFamily / isFableFamily', () => {
  assert.equal(modelFamily('claude-opus-4-8'), 'opus')
  assert.equal(modelFamily('seven_day_Sonnet'), 'sonnet')
  assert.equal(modelFamily('gpt-5'), null)
  assert.ok(isFableFamily('claude-fable-5'))
  assert.ok(isFableFamily('週(Mythos)'))
  assert.ok(!isFableFamily('週(Opus)'))
})

test('isOfficialLimits', () => {
  assert.ok(!isOfficialLimits({ fiveHour: plan('local'), weekly: plan('local') }))
  assert.ok(isOfficialLimits({ fiveHour: plan('local'), weekly: plan('official') }))
})
