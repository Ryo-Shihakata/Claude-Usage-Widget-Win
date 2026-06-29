import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

/** userData 配下の単純な JSON 永続ストア */
export class JsonStore<T extends object> {
  private path: string
  private data: T

  constructor(filename: string, defaults: T) {
    this.path = join(app.getPath('userData'), filename)
    this.data = defaults
    if (existsSync(this.path)) {
      try {
        this.data = { ...defaults, ...JSON.parse(readFileSync(this.path, 'utf8')) }
      } catch {
        // 壊れた設定ファイルは無視してデフォルトを使う
      }
    }
  }

  get(): T {
    return this.data
  }

  set(patch: Partial<T>): T {
    this.data = { ...this.data, ...patch }
    this.save()
    return this.data
  }

  private save(): void {
    try {
      writeFileSync(this.path, JSON.stringify(this.data, null, 2))
    } catch {
      // 保存失敗は致命的でないため無視
    }
  }
}
