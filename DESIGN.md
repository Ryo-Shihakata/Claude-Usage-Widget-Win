# 設計書 — Claude Usage Widget（引き継ぎ用）

このドキュメントは、別のエージェント/開発者がこのコードベースを引き継いで作業するための設計仕様です。**何が・どこに・なぜ**あるかと、踏みやすい落とし穴をまとめています。実装日: 2026-06-29。

- 利用方法は [README.md](README.md)、リリース手順は [RELEASING.md](RELEASING.md) を参照。
- このファイルは実装の内部仕様にフォーカスします。

---

## 1. 目的とスコープ

Claude Code の使用量をデスクトップに常時表示するフローティングウィジェット。

- **対象データ**: ローカルの Claude Code セッションログ（`~/.claude/projects/**/*.jsonl`）のみ。外部API・認証は使わない。
- **表示**: ①利用枠ゲージ2本（5時間枠 / 週間枠 ＝ Claude のレート制限に対応する**ローカル推定**）②今日のモデル別トークン/活動量 ③推定コスト(USD)。
- **更新**: ファイル監視＋ポーリングで自動。
- **`/usage` との関係（重要）**: 利用枠の値は**ローカルログのトークン量からの推定**であり、公式 `/usage` のプラン残量とは別物（公式の残量データはローカルに存在しない）。UI でも「推定（ローカル集計）」と明示し、`/usage` という語は使わない。基準値はユーザーが調整する前提。
- **非対象（現状）**: 公式 `/usage` 実データの取得（OAuthトークン経由の非公開API。脆く既定では扱わない）、グラフ/履歴、macOS/Linux 最適化。→ §11 拡張ポイント。

---

## 2. アーキテクチャ

```
┌──────────────────────────── Electron main (Node 権限) ────────────────────────────┐
│  index.ts  …… アプリのライフサイクル / BrowserWindow / Tray / IPC ハンドラ          │
│     │                                                                              │
│     ├─ window.ts ……… フレームレス・半透明・最前面ウィンドウ生成                    │
│     ├─ store.ts  ……… settings.json / window-bounds.json の永続化(userData)         │
│     └─ usage/                                                                       │
│          ├─ watcher.ts  … chokidar 監視 + 30秒ポーリング → tick() → スナップショット │
│          ├─ collector.ts … jsonl をインクリメンタル走査し集計（中核）               │
│          └─ pricing.ts  … モデル別単価 → コスト推定                                  │
│                                  │ IPC: 'usage:update' (push)                       │
│                                  ▼                                                  │
│  preload/index.ts …… contextBridge で window.widget API を renderer に公開          │
└────────────────────────────────────┼───────────────────────────────────────────────┘
                                      ▼
┌──────────────────────── renderer (Chromium / React) ─────────────────────────────┐
│  App.tsx → LimitPanel / TokenPanel / CostPanel  …… 3パネル UI                      │
└───────────────────────────────────────────────────────────────────────────────────┘

shared/  …… main・renderer 双方が import する型(types.ts)と IPC チャンネル名(ipc.ts)
```

ビルドは **electron-vite**。`main` / `preload` / `renderer` の3ターゲットを `electron.vite.config.ts` で定義し、`out/` に出力。

---

## 3. データソースと前提

### 入力ファイル
- パス: `${CLAUDE_CONFIG_DIR or ~/.claude}/projects/<project>/<session>.jsonl`
- 形式: 1行1 JSON オブジェクト、**追記専用（append-only）**。
- セッションID = jsonl のファイル名（拡張子除く）。

### 集計対象の行
`type === "assistant"` かつ `message.usage` と `message.model` を持つ行のみ。抽出フィールド:

| jsonl のキー | 用途 |
| --- | --- |
| `message.usage.input_tokens` | input |
| `message.usage.output_tokens` | output |
| `message.usage.cache_creation_input_tokens` | cache write |
| `message.usage.cache_read_input_tokens` | cache read |
| `message.model` | モデルID |
| `timestamp`（トップレベル, ISO） | 時刻 |
| `message.id`（無ければ `uuid`） | 重複排除キー |

### 重複排除
キー = `message.id ?? uuid ?? "${sessionId}:${ts}"`。`seenIds: Set` で二重計上を防止。`uuid` は行ごとに一意のため、オフセット管理と併せて実質的に同一行を二度数えない。

---

## 4. データフロー

### 起動シーケンス（`index.ts` の `app.whenReady`）
1. `settingsStore` / `boundsStore` を生成（**`whenReady` 後**。`app.getPath('userData')` が必要なため。module ロード時に作ると `app` 未定義でクラッシュする — §10）。
2. `registerIpc()` で IPC ハンドラ登録。
3. `createWidgetWindow()` でウィンドウ生成（保存位置・最前面設定を反映）。
4. `buildTray()` でトレイ生成。
5. `UsageWatcher` を生成し `start()`。

### 更新サイクル（`watcher.ts`）
1. `start()` で初回 `tick()`（**全ファイルをオフセット0からフルスキャン**）。
2. `chokidar.watch(projects, { depth:2, awaitWriteFinish })` を設定し、`'ready'` を待ってから（最大2秒フォールバック）監視開始。
3. `.jsonl` の `add`/`change` → `scheduleTick()`（**1.2秒デバウンス**）→ `tick()`。
4. 併せて **30秒ポーリング**（取りこぼし防止＋5時間枠の時間経過反映）。
5. `tick()` = `collector.refresh()`（追記分の取り込み）→ `collector.buildSnapshot()` → `onSnapshot(snap)` コールバック。
6. `index.ts` の `pushSnapshot()` が `win.webContents.send('usage:update', snap)` で renderer へ。
7. renderer は `window.widget.onUsage()` で購読し state 更新 → 再描画。

設定変更時は再スキャン不要なため `watcher.emitCurrent()` で現在のレコードから即再生成。

---

## 5. モジュール責務

| ファイル | 責務 / 主要シンボル |
| --- | --- |
| `src/main/index.ts` | ライフサイクル、`buildTray`/`refreshTrayMenu`、`pushSnapshot`、`updateTrayIndicator`（リングゲージ+ツールチップ）、`setupAutoUpdate`（electron-updater）、IPC、単一インスタンスロック、トレイ常駐 |
| `src/main/window.ts` | `createWidgetWindow()`。`frame:false, transparent:true, alwaysOnTop, skipTaskbar, resizable:false`。`moved` で位置保存。dev は `ELECTRON_RENDERER_URL`、prod は `loadFile` |
| `src/main/store.ts` | `JsonStore<T>`。userData 配下の JSON を読み書き。壊れていればデフォルト |
| `src/main/trayIcon.ts` | `renderTrayIcon(fraction)`。リングゲージ PNG を zlib で生成（トレイの常時表示用） |
| `src/main/usage/collector.ts` | **中核**。`UsageCollector`。`refresh()`/`buildSnapshot()`/`readNewLines()`/`parseLine()`/`prune()`。`buildLimit()` は `source:'local'`。`defaultClaudeDir()` |
| `src/main/usage/pricing.ts` | `RATES` テーブル＋`resolveRate()`（族名フォールバック）＋`estimateCost()` |
| `src/main/usage/officialUsage.ts` | **オプトイン**。`openClaudeLogin()`（永続パーティション `persist:claudeai` で claude.ai ログイン窓）/`isClaudeLoggedIn()`/`fetchOfficialLimits()`：Cookie の `lastActiveOrgId` で `GET https://claude.ai/api/organizations/{orgId}/usage` を `net.request`（セッションCookie付与）で叩き、`{five_hour,seven_day}.utilization`(0..100) を `UsageLimits`(`source:'official'`) に変換。失敗時 null→ローカルへ。`CUW_USAGE_ORIGIN` で origin 上書き可 |
| `src/main/usage/watcher.ts` | `UsageWatcher`。監視＋ポーリング＋デバウンス、`tick()`/`emitCurrent()`/`buildAndEmit()`（公式ON時に limits を上書き）/`stop()` |
| `src/main/usage/collect-cli.ts` | `npm run collect` 用。集計結果を標準出力（Electron 不要の検証手段） |
| `src/preload/index.ts` | `contextBridge.exposeInMainWorld('widget', api)`。`onUsage/getSettings/setSettings/refresh/quit` |
| `src/preload/index.d.ts` | renderer 用に `window.widget` 型を宣言 |
| `src/renderer/App.tsx` | 購読・設定取得・設定パネル・3パネルの組み立て |
| `src/renderer/components/*` | `LimitPanel`（5h/週間の2ゲージ＋内部`Gauge`）/`TokenPanel`（モデル別）/`CostPanel`（USD） |
| `src/renderer/format.ts` | `fmtTokens`(5.1M形式)/`fmtUSD`/`shortModel`/`fmtResetTime` |
| `src/shared/types.ts` | `UsageSnapshot`/`WindowAggregate`/`ModelTokens`/`PlanLimit`/`WidgetSettings`/`DEFAULT_SETTINGS` |
| `src/shared/ipc.ts` | IPC チャンネル名定数 `IPC` |
| `scripts/make-icon.mjs` | `resources/icon.png` を zlib のみで生成（依存なし） |

---

## 6. データモデル（`shared/types.ts`）

```ts
UsageSnapshot {
  generatedAt: string            // ISO
  today / last5h / last7d: WindowAggregate
  limits: { fiveHour: PlanLimit; weekly: PlanLimit }   // 5時間枠・週間枠（推定）
  sessionCount: number           // 今日の distinct セッション数
  status: string | null          // 異常時メッセージ（正常は null）
}
WindowAggregate {
  byModel: Record<modelId, ModelTokens>
  totalTokens: number            // input+output+cache 全種別
  messageCount: number
  costUSD: number
}
PlanLimit {
  windowTokens, baselineTokens, fraction(0..1), windowResetsAt: string|null,
  source: 'local' | 'official'   // local=推定 / official=公式実データ
}
WidgetSettings {
  fiveHourBaselineTokens,        // 既定 85_000_000（ユーザー調整済）
  weeklyBaselineTokens,          // 既定 430_000_000
  showCost, alwaysOnTop,
  launchAtLogin,                 // 既定 true（自動起動デフォルトON）
  useOfficialUsage               // 既定 false（公式 /usage 連携・実験的）
}
```

### ウィンドウ定義（`buildSnapshot`）
- **today**: ローカル0時以降。
- **last5h**: `now - 5h` 以降のローリング。
- **last7d**: `now - 7d` 以降のローリング。
- `limits.fiveHour.windowTokens = last5h.totalTokens`、`limits.weekly.windowTokens = last7d.totalTokens`。各 `fraction = min(1, windowTokens / baseline)`。
- `windowResetsAt = (枠内で最古のレコードts) + 枠長`（5h枠は+5h、週間枠は+7d。＝この枠が緩み始める目安）。
- 生成はヘルパ `buildLimit(windowTokens, baseline, recs, windowMs)` に集約。

---

## 7. IPC 契約（`shared/ipc.ts` / preload）

| チャンネル | 方向 | 種別 | ペイロード |
| --- | --- | --- | --- |
| `usage:update` | main→renderer | send | `UsageSnapshot` |
| `settings:get` | renderer→main | invoke | → `WidgetSettings` |
| `settings:set` | renderer→main | invoke | `Partial<WidgetSettings>` → `WidgetSettings` |
| `usage:refresh` | renderer→main | invoke | → `UsageSnapshot \| null`（再スキャン後） |
| `app:quit` | renderer→main | send | なし |

renderer からは `window.widget.*`（preload）経由でのみアクセス。`contextIsolation: true`、`sandbox: false`（preload で Node API は使わないが将来用に false）。

---

## 8. 設定と永続化

- 保存先: `app.getPath('userData')`（Windows は `%APPDATA%/claude-usage-widget/`）。
- `settings.json` … `WidgetSettings`。
- `window-bounds.json` … `{ x, y }`。`moved` イベントで都度保存。
- 自動起動は `app.setLoginItemSettings({ openAtLogin })`。
- 設定の単一の真実は **main 側の `settingsStore`**。renderer・トレイ双方が `settings:set` / メニューハンドラ経由で更新し、`emitCurrent()` で即反映。

---

## 9. UI（renderer）

- `widget` ルートが半透明ダークカード（`styles.css` の CSS 変数で配色）。
- ヘッダに `-webkit-app-region: drag`、ボタンに `no-drag`。
- ゲージ色は `fraction` で `ok(<0.5)/warn(<0.8)/danger(>=0.8)`。
- `snap.status` が非 null のときは集計を出さずステータス文言を表示。
- CSP は `index.html` の meta で `default-src 'self'`（`unsafe-inline` は style のみ許可）。

---

## 10. 既知の制約・落とし穴（重要）

1. **エージェントサンドボックスで GUI 起動不可**: 実行環境が `ELECTRON_RUN_AS_NODE=1` を強制すると、Electron が browser プロセスではなく Node として動き `require('electron')` が機能せず `electron.app` が undefined になる。→ GUI 検証は**実機の `npm run dev` のみ**。集計ロジックは `npm run collect` や tsx で Electron 抜きに検証する。
2. **module ロード時に `app.getPath()` を呼ばない**: ストア生成は必ず `whenReady` 後。初版で top-level 生成して即クラッシュした（修正済み）。
3. **libuv の 8.3 短縮名クラッシュ**: `os.tmpdir()`（例 `C:\Users\RYOTAK~1\...`）配下を `fs.watch`/chokidar で監視すると libuv が `fs-event.c` でアサート失敗してクラッシュする。テストはロングパス配下で行う。実運用の `~/.claude` はロングパスなので影響なし。
4. **chokidar の `ready` 待ち**: `start()` 直後の追記を取りこぼさないよう `'ready'` を待つ（2秒フォールバック付き）。
5. **オフセットは非永続（メモリのみ）**: 起動毎に全ファイルをフルスキャンしてレコードを再構築する設計。時間ウィンドウ集計には7日分のレコードが要るため、オフセットだけ永続しても末尾からでは履歴を復元できない。フルスキャンは実測で数十ms（§12）なので許容。→ 計画当初の `~/.claude/.usage-widget-cache.json` 永続化は**未採用**。巨大化した場合の最適化は §11。
6. **`transparent: true` + Windows**: `backgroundColor:'#00000000'`、`hasShadow:false`、`ready-to-show` で表示。リサイズ無効。
7. **`window-all-closed` で終了しない**: トレイ常駐が仕様。終了はトレイ「終了」または `app:quit`。

---

## 11. 拡張ポイント

- **公式 `/usage` 実データ連携（オプトイン）**: 現状の利用枠は**ローカル推定**。正確なプラン残量が欲しい場合のみ、設定で明示有効化したときだけ `~/.claude/.credentials.json` のアクセストークンで Claude の使用量エンドポイントを叩く実装を追加。既定オフ・トークンは Anthropic 以外に送らない・失敗時はローカル枠へフォールバック。エンドポイント仕様は要検証（非公開・変更リスク）。`PlanLimit` に `source: 'local' | 'official'` を足すと UI 分岐しやすい（5h/週間とも置換可能に）。
- **オフセット永続化**: 起動が重くなった場合、7日分のレコードを `userData` にキャッシュし、起動時はキャッシュ＋差分読みに切替（§10-5 の代替）。
- **履歴グラフ**: `WindowAggregate` を日次で保持し、スパークラインを追加。
- **モデル別の内訳表示**: 現状は上位2モデル。展開UIで全モデル＋cache 内訳を表示可能。
- **単価の外部化**: `pricing.ts` の `RATES` を JSON 化し、claude-api スキルから自動更新。

---

## 12. 検証レシピ

### 集計の正しさ（Electron 不要）
```bash
npm run collect
```
`~/.claude/stats-cache.json` の日次モデル別トークンと、同一日の出力が概ね一致することを確認。実測: フルスキャン約32ms。

### ライブ更新（監視→再集計）
一時的に統合ハーネスを作って検証する手順（実施済み・PASS）:
1. ロングパス配下（例 `process.cwd()` 直下。**`os.tmpdir()` は §10-3 で不可**）に `projects/p/sess.jsonl` を作成し assistant usage 行を1行書く。
2. `CLAUDE_CONFIG_DIR` をその基底に設定。
3. `new UsageWatcher(()=>DEFAULT_SETTINGS, onSnap).start()` → 初回スナップショットを確認。
4. 同ファイルへ2行 `appendFileSync` → 1.2秒デバウンス＋猶予（合計~2.5s）待機。
5. `today.totalTokens` と `messageCount` が増えれば PASS。
（過去に `src/_watcher-test.ts` として作成→検証後に削除。再実施時も使い捨てとし、コミットしないこと。）

### 型・ビルド
```bash
npm run typecheck   # tsconfig.node.json + tsconfig.web.json
npm run build       # out/ に main/preload/renderer
```

### 配布物（インストーラ＋ポータブル）
```bash
npm run package
```
`release/` に NSIS インストーラ（`*-Setup-*.exe`）とポータブル（`ClaudeUsageWidget-portable-*.exe`）が生成される。`win.target=["nsis","portable"]`、`nsis.perMachine=false`（管理者権限不要）、`extraResources` で `resources/icon.png` を同梱（パッケージ後もトレイアイコンが出る）。

> ⚠️ **ビルド時の前提**: electron-builder は初回に `winCodeSign` キャッシュを展開する際、内部の macOS 用 `.dylib` **シンボリックリンク**を作成する。Windows でシンボリックリンク作成権限が無いと `Cannot create symbolic link ... 必要な特権を保有していません` で失敗する。対策: **Windows の「開発者モード」をON**にする（推奨）か、ターミナルを**管理者**で実行。署名はしていないが展開自体に必要。これは環境側の権限問題で、`build` 設定は正しい。

### GUI（実機のみ）
```bash
npm run dev
```
別ターミナルで Claude Code を1ターン動かし、数秒以内に**2本のゲージ（5時間/週間）**が増えること、ドラッグ移動・位置保存・トレイ操作・最前面トグル・自動起動トグルを目視確認。

---

## 13. TODO / 未完了

- [ ] 実機での GUI 目視確認（サンドボックス制約で未実施。§10-1）。Claude Code 風配色・2ゲージ・トレイのリングゲージ・自動起動の見た目確認。
- [ ] **公式 `/usage` の実機動作確認**（`officialUsage.ts`）。方式は確定（claude.ai セッションCookie + `GET /api/organizations/{orgId}/usage`、レスポンス `{five_hour,seven_day}.utilization`）。要確認: ①ログイン窓で claude.ai にログイン→Cookie 永続、②`net.request` にセッションCookieが付き 200 で usage が返る、③Electron UA が弾かれないか（弾かれたら UA 調整）。非公開Web APIのため将来の仕様変更に注意。失敗時はローカル推定へフォールバックするので無害。
- [ ] 利用枠の基準値（5h=85M/週=430M）は暫定。実利用データで既定を後調整。
- [ ] 自動アップデートの実機検証（インストーラ版で v を上げて配信→適用を確認）。GitHub の**下書きリリースを Publish** しないと updater は拾わない。
- [ ] アイコンの `.ico` 同梱（現状 256px PNG を electron-builder が変換）。
- [ ] 多モニタ環境での初期位置クランプ（画面外に出た保存位置の補正）。
