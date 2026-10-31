// 公式 /usage 取得の診断ログ: 失敗は常に warn、詳細（本文・成功値）は CUW_DEBUG=1 のときだけ。
// trim(): cmd の `set VAR=1 && ...` 形式だと値に末尾スペースが入るため防御
export const DEBUG = ['1', 'true'].includes((process.env.CUW_DEBUG ?? '').trim())

export function dbg(...a: unknown[]): void {
  if (DEBUG) console.log('[official]', ...a)
}

export function warn(...a: unknown[]): void {
  console.warn('[official]', ...a)
}
