import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateCost } from '../src/main/usage/pricing'
import { renderTrayIcon } from '../src/main/trayIcon'
import { fmtClock, fmtTokens, fmtUSD, shortModel } from '../src/renderer/format'

const t = (i: number, o: number, cw = 0, cr = 0) => ({
  inputTokens: i,
  outputTokens: o,
  cacheCreationTokens: cw,
  cacheReadTokens: cr
})

test('estimateCost: 完全一致・族名フォールバック・不明モデル', () => {
  assert.equal(estimateCost('claude-sonnet-4-6', t(1e6, 1e6)), 18)
  assert.equal(estimateCost('claude-opus-9-9', t(1e6, 0, 1e6, 1e6)), 5 + 6.25 + 0.5)
  assert.equal(estimateCost('claude-mythos-6', t(0, 1e6)), 50)
  assert.equal(estimateCost('gpt-5', t(1e6, 1e6)), 0)
})

test('renderTrayIcon: 32x32 の PNG を返し、範囲外の値もクランプ', () => {
  for (const f of [-1, 0, 0.5, 0.75, 0.95, 2]) {
    const png = renderTrayIcon(f)
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.equal(png.readUInt32BE(16), 32)
    assert.equal(png.readUInt32BE(20), 32)
  }
  assert.deepEqual(renderTrayIcon(-1), renderTrayIcon(0))
  assert.deepEqual(renderTrayIcon(2), renderTrayIcon(1))
  assert.notDeepEqual(renderTrayIcon(0.5), renderTrayIcon(0.95))
})

test('format', () => {
  assert.equal(fmtTokens(999), '999')
  assert.equal(fmtTokens(1500), '1.5K')
  assert.equal(fmtTokens(5_100_000), '5.10M')
  assert.equal(fmtTokens(2e9), '2.00B')
  assert.equal(fmtUSD(1.234), '$1.23')
  assert.equal(fmtUSD(123.4), '$123')
  assert.equal(shortModel('claude-opus-4-8'), 'Opus')
  assert.equal(shortModel('claude-fable-5'), 'Fable')
  assert.equal(shortModel('claude-sonnet-4-6'), 'Sonnet')
  assert.equal(shortModel('claude-mythos-5'), 'Mythos')
  assert.equal(shortModel('claude-foo-1'), 'foo-1')
  assert.equal(fmtClock(undefined), '--:--')
  assert.equal(fmtClock('nope'), '--:--')
  assert.match(fmtClock(new Date().toISOString()), /^\d{2}:\d{2}:\d{2}$/)
})
