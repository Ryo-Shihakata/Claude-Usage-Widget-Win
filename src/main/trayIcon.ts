import { deflateSync } from 'zlib'
import { clamp01, usageLevel, type UsageLevel } from '../shared/usage'

/**
 * トレイ用のリングゲージ・アイコンを PNG バッファで生成する。
 * fraction(0..1) に応じて上から時計回りにリングが満ち、レベルで色が変わる。
 * （最小化中もトレイで利用枠が一目で分かるようにするため。）
 */
const SIZE = 32

const LEVEL_COLOR: Record<UsageLevel, [number, number, number]> = {
  danger: [0xc8, 0x55, 0x3d],
  warn: [0xe0, 0xa2, 0x3d],
  ok: [0xd9, 0x77, 0x57] // coral
}

function crc32(buf: Buffer): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}
function encodePng(px: Buffer): Buffer {
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
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** fraction に応じたリングゲージ PNG を返す */
export function renderTrayIcon(fraction: number): Buffer {
  const f = clamp01(fraction)
  const px = Buffer.alloc(SIZE * SIZE * 4)
  const cx = SIZE / 2
  const cy = SIZE / 2
  const outerR = SIZE * 0.46
  const innerR = SIZE * 0.28
  const [r, g, b] = LEVEL_COLOR[usageLevel(f)]
  const TAU = Math.PI * 2
  const filledAngle = f * TAU

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      const dist = Math.hypot(dx, dy)
      if (dist < innerR || dist > outerR) {
        px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0
        continue
      }
      // 上(12時)から時計回りの角度 0..TAU
      const a = Math.atan2(dy, dx)
      const t = (a + Math.PI / 2 + TAU) % TAU
      if (t <= filledAngle) {
        px[i] = r
        px[i + 1] = g
        px[i + 2] = b
        px[i + 3] = 255
      } else {
        // 未消費部分は暗いトラック
        px[i] = 0x55
        px[i + 1] = 0x52
        px[i + 2] = 0x4e
        px[i + 3] = 180
      }
    }
  }
  return encodePng(px)
}
