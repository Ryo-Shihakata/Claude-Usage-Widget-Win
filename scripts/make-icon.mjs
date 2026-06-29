// resources/icon.png を生成する（依存ライブラリなし、zlib のみ）。
// 暖色ダークの角丸スクエア上に、コーラルの12本サンバースト（Claude 風）。
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SIZE = 256
const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'resources', 'icon.png')

const px = Buffer.alloc(SIZE * SIZE * 4)
const cx = SIZE / 2
const cy = SIZE / 2
const margin = SIZE * 0.06
const cornerR = SIZE * 0.16

// 背景（暖色ダーク #262624）色
const BG = [0x26, 0x26, 0x24]
// コーラル #D97757
const CORAL = [0xd9, 0x77, 0x57]

const RAYS = 12
const outerR = SIZE * 0.4
const hubR = SIZE * 0.055
const TAU = Math.PI * 2

// 角丸スクエアの内外判定（角だけ丸める）
function insideRoundedSquare(x, y) {
  const dxEdge = Math.max(margin - x, x - (SIZE - margin), 0)
  const dyEdge = Math.max(margin - y, y - (SIZE - margin), 0)
  if (dxEdge === 0 && dyEdge === 0) return true
  return Math.hypot(dxEdge, dyEdge) <= cornerR
}

// サンバースト判定（0..1 の強度、アンチエイリアス用）
// 各レイは中心(hub)と外周で幅0、中間で最大となる紡錘形（leaf）。
function burstIntensity(x, y) {
  const dx = x - cx
  const dy = y - cy
  const r = Math.hypot(dx, dy)
  if (r <= hubR) return 1
  if (r >= outerR) return 0
  const a = Math.atan2(dy, dx)
  // 最寄りのレイ中心への角度差
  let da = Infinity
  for (let k = 0; k < RAYS; k++) {
    const ang = (k / RAYS) * TAU
    let d = Math.abs(a - ang) % TAU // まず [0,TAU) に正規化
    if (d > Math.PI) d = TAU - d // 最短角へ
    if (d < da) da = d
  }
  // hub→rim を 0..1 に正規化し、両端で 0・中間で最大の幅
  const u = (r - hubR) / (outerR - hubR)
  const half = (Math.PI / RAYS) * 0.6 * Math.sin(Math.PI * u)
  const band = (Math.PI / RAYS) * 0.12 // ソフトエッジ
  return Math.max(0, Math.min(1, (half - da) / band + 0.5))
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4
    if (!insideRoundedSquare(x, y)) {
      px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0
      continue
    }
    const burst = burstIntensity(x, y)
    px[i] = Math.round(BG[0] + (CORAL[0] - BG[0]) * burst)
    px[i + 1] = Math.round(BG[1] + (CORAL[1] - BG[1]) * burst)
    px[i + 2] = Math.round(BG[2] + (CORAL[2] - BG[2]) * burst)
    px[i + 3] = 255
  }
}

// ---- PNG エンコード ----
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8
ihdr[9] = 6 // RGBA
const stride = SIZE * 4
const raw = Buffer.alloc((stride + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
  raw[y * (stride + 1)] = 0
  px.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
}
const idat = deflateSync(raw)
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0))
])
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, png)
console.log('wrote', out, png.length, 'bytes')
