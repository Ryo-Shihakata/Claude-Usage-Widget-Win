# 設計書 — Claude Usage Widget（引き継ぎ用）

このドキュメントは、別のエージェント/開発者がこのコードベースを引き継いで作業するための設計仕様です。**何が・どこに・なぜ**あるかと、踏みやすい落とし穴をまとめています。初版実装日: 2026-06-29。v0.3.0（クラウド既定化・ターミナルUI・clawd・Fable対応）: 2026-07-04。

- 利用方法は [README.md](README.md)、リリース手順は [RELEASING.md](RELEASING.md) を参照。
- このファイルは実装の内部仕様にフォーカスします。

---

## 1. 目的とスコープ

Claude Code の使用量をデスクトップに常時表示するフローティングウィジェット。ターミナル風の窓（ドット付きヘッダ＋ステータスバー）にマスコット **clawd** が常駐する。

- **対象データ**: ①claude.ai の公式 `/usage`（**既定**。クラウド／アカウント全体の利用率）②ローカルの Claude Code セッションログ（`~/.claude/projects/**/*.jsonl`。未ログイン・取得失敗時のフォールバック推定）。
- **表示**: ①利用枠ゲージ（5時間枠 / 週間枠 ＋ 公式レスポンスにある追加枠）②今日のモデル別トークン/活動量（Opus/Sonnet/Haiku/Fable/Mythos 対応）③推定コスト(USD) ④ステータスバー（clawd・モード・時刻）。
- **更新**: ファイル監視＋ポーリング＋（クラウード既定時）60秒キャッシュ付きの公式取得で自動。
- **`/usage` との関係（重要・v0.3.0で変更）**: **既定はクラウドモード**——claude.ai のセッションCookieで公式の使用量を取得し、`/usage` コマンドと同じ値をそのまま表示する（`source:'official'`）。未ログイン・通信失敗時のみ**ローカルログからの推定**にフォールバックする（`source:'local'`、公式値とは完全一致しない）。UI はどちらのモードかを「☁ 公式」/「⌂ 推定」で明示する。
- **非対象（現状）**: グラフ/履歴、macOS/Linux 最適化。→ §11 拡張ポイント。

---

## 2. アーキテクチャ

```
┌──────────────────────────── Electron main (Node 権限) ────────────────────────────┐
│  index.ts  …… ライフサイクル / BrowserWindow / Tray / IPC / applyLoginItem /        │
│               applyWindowHeight（動的リサイズ）                                    │
│     │                                                                              │
│     ├─ window.ts ……… フレームレス・半透明・最前面ウィンドウ生成                    │
│     ├─ store.ts  ……… settings.json / window-bounds.json の永続化(userData)         │
│     ├─ trayIcon.ts …… リングゲージ PNG 生成（トレイ用）                             │
│     └─ usage/                                                                       │
│          ├─ watcher.ts     … chokidar監視+30秒ポーリング → tick() → buildAndEmit    │
│          ├─ collector.ts   … jsonl をインクリメンタル走査し集計（ローカル推定）     │
│          ├─ officialUsage.ts … claude.ai セッションCookieで公式usage取得（既定）    │
│          └─ pricing.ts     … モデル別単価 → コスト推定（Fable/Mythos含む）          │
│                                  │ IPC: 'usage:update' (push)                       │
│                                  ▼                                                  │
│  preload/index.ts …… contextBridge で window.widget API を renderer に公開          │
└────────────────────────────────────┼───────────────────────────────────────────────┘
                                      ▼
┌──────────────────────── renderer (Chromium / React) ─────────────────────────────┐
│  App.tsx（ターミナル風ヘッダ＋設定オーバーレイ＋ステータスバー）                    │
│    → LimitPanel（ゲージ+extras+ログイン促し） / TokenPanel / CostPanel / Clawd     │
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
| `src/main/index.ts` | ライフサイクル、`buildTray`/`refreshTrayMenu`、`pushSnapshot`、`updateTrayIndicator`（リングゲージ+ツールチップ）、`applyLoginItem(enabled)`（**dev では常にOFF**——§10の新罠を参照）、`applyWindowHeight(snap)`（extras数/コスト表示で高さ動的調整）、`setupAutoUpdate`（electron-updater）、IPC、単一インスタンスロック、トレイ常駐 |
| `src/main/window.ts` | `createWidgetWindow()`。`frame:false, transparent:true, alwaysOnTop, skipTaskbar, resizable:false`（初期 316px、以後 main が `setSize` で調整）。`moved` で位置保存。dev は `ELECTRON_RENDERER_URL`、prod は `loadFile` |
| `src/main/store.ts` | `JsonStore<T>`。userData 配下の JSON を読み書き。壊れていればデフォルト |
| `src/main/trayIcon.ts` | `renderTrayIcon(fraction)`。リングゲージ PNG を zlib で生成（トレイの常時表示用） |
| `src/main/usage/collector.ts` | **ローカル推定（フォールバック）の中核**。`UsageCollector`。`refresh()`/`buildSnapshot()`/`readNewLines()`/`parseLine()`/`prune()`。`buildLimit()` は `source:'local'`。`defaultClaudeDir()` |
| `src/main/usage/pricing.ts` | `RATES` テーブル（Opus/Sonnet/Haiku/**Fable/Mythos**）＋`resolveRate()`（族名フォールバック、`fable`/`mythos`含む）＋`estimateCost()` |
| `src/main/usage/officialUsage.ts` | **公式取得（既定）**。`openClaudeLogin()`（永続パーティション `persist:claudeai` で claude.ai ログイン窓。閉じたら `clearOfficialCache()`）/`isClaudeLoggedIn()`/`fetchOfficialLimits()`：Cookie の `lastActiveOrgId` で `GET https://claude.ai/api/organizations/{orgId}/usage` を `net.request`（セッションCookie付与、60秒キャッシュ）で叩き、`{five_hour,seven_day}.utilization`(0..100) を `UsageLimits`(`source:'official'`) に変換。**その他の `utilization` を持つキーは `extras: LabeledLimit[]` として `labelFor()` でラベル付けし自動収集**（例: `seven_day_opus`→「週(Opus)」）。失敗時 null→ローカルへ。`CUW_USAGE_ORIGIN` で origin 上書き可 |
| `src/main/usage/watcher.ts` | `UsageWatcher`。監視＋ポーリング＋デバウンス、`tick()`/`emitCurrent()`/`buildAndEmit()`（`useOfficialUsage`時に limits を公式で上書き、取得失敗ならローカルのまま）/`stop()` |
| `src/main/usage/collect-cli.ts` | `npm run collect` 用。集計結果を標準出力（Electron 不要の検証手段。**常にローカル推定のみ**——officialUsage は Electron 依存のためCLIでは呼ばない） |
| `src/preload/index.ts` | `contextBridge.exposeInMainWorld('widget', api)`。`onUsage/getSettings/setSettings/refresh/loginClaude/quit` |
| `src/preload/index.d.ts` | renderer 用に `window.widget` 型を宣言 |
| `src/renderer/App.tsx` | 購読・設定取得・ターミナル風ヘッダ・設定オーバーレイ・ステータスバー・パネル組み立て |
| `src/renderer/components/*` | `LimitPanel`（5h/週間+`extras`のゲージ列＋未ログイン時のログイン促しボタン）/`TokenPanel`/`CostPanel`/`Clawd`（自作SVGマスコット、コーラル単色） |
| `src/renderer/format.ts` | `fmtTokens`(5.1M形式)/`fmtUSD`/`shortModel`(fable対応済)/`fmtResetTime`（同日ならHH:MM、別日ならM/D HH:MM） |
| `src/shared/types.ts` | `UsageSnapshot`/`WindowAggregate`/`ModelTokens`/`PlanLimit`/`LabeledLimit`/`UsageLimits`(`extras?`)/`WidgetSettings`/`DEFAULT_SETTINGS`（`useOfficialUsage: true`） |
| `src/shared/ipc.ts` | IPC チャンネル名定数 `IPC`（`claudeLogin` 追加） |
| `scripts/make-icon.mjs` | `resources/icon.png` を zlib のみで生成（依存なし） |

---

## 6. データモデル（`shared/types.ts`）

```ts
UsageSnapshot {
  generatedAt: string            // ISO
  today / last5h / last7d: WindowAggregate
  limits: UsageLimits
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
LabeledLimit { label: string; limit: PlanLimit }   // 公式レスポンスの追加枠
UsageLimits {
  fiveHour: PlanLimit
  weekly: PlanLimit
  extras?: LabeledLimit[]         // 公式取得時のみ。ローカル推定時は undefined
}
WidgetSettings {
  fiveHourBaselineTokens,        // 既定 85_000_000（ローカル推定モード時のみ使用）
  weeklyBaselineTokens,          // 既定 430_000_000（同上）
  showCost, alwaysOnTop,
  launchAtLogin,                 // 既定 true（自動起動デフォルトON。ただし dev では常にOFF——§10）
  useOfficialUsage               // 既定 true（v0.3.0でクラウード既定化）
}
```

### ウィンドウ定義

**ローカル推定（`collector.buildSnapshot`、フォールバック時のみ使用）**:
- **today**: ローカル0時以降。**last5h**: `now-5h`以降。**last7d**: `now-7d`以降。
- `limits.fiveHour.windowTokens = last5h.totalTokens`、`limits.weekly.windowTokens = last7d.totalTokens`。各 `fraction = min(1, windowTokens / baseline)`。
- `windowResetsAt = (枠内で最古のレコードts) + 枠長`（5h枠は+5h、週間枠は+7d）。
- 生成はヘルパ `buildLimit(windowTokens, baseline, recs, windowMs)` に集約。

**公式取得（`officialUsage.mapUsage`、既定パス）**:
- `five_hour`/`seven_day` の `utilization`(0..100) を `/100` して `fraction` に。`windowTokens`/`baselineTokens` は意味を持たず `0` 固定（UI は `source==='official'` なら「公式値」とだけ表示しトークン数は出さない）。
- それ以外の `utilization` を持つキーは `extras` へ（未検証のレスポンス形状に対する防御的パース。§10参照）。

---

## 7. IPC 契約（`shared/ipc.ts` / preload）

| チャンネル | 方向 | 種別 | ペイロード |
| --- | --- | --- | --- |
| `usage:update` | main→renderer | send | `UsageSnapshot` |
| `settings:get` | renderer→main | invoke | → `WidgetSettings` |
| `settings:set` | renderer→main | invoke | `Partial<WidgetSettings>` → `WidgetSettings` |
| `usage:refresh` | renderer→main | invoke | → `UsageSnapshot \| null`（再スキャン後） |
| `claude:login` | renderer→main | send | なし（`openClaudeLogin()` を呼ぶだけ） |
| `app:quit` | renderer→main | send | なし |

renderer からは `window.widget.*`（preload）経由でのみアクセス。`contextIsolation: true`、`sandbox: false`（preload で Node API は使わないが将来用に false）。

---

## 8. 設定と永続化

- 保存先: `app.getPath('userData')`（Windows は `%APPDATA%/claude-usage-widget/`）。
- `settings.json` … `WidgetSettings`。
- `window-bounds.json` … `{ x, y }`。`moved` イベントで都度保存。
- 自動起動は `applyLoginItem(enabled)`（`index.ts`）経由でのみ行う。**直接 `app.setLoginItemSettings()` を呼ばないこと**——`app.isPackaged` でガードしており、dev では設定値に関わらず常に `openAtLogin:false` を送って stale 登録を掃除する（§10 の罠を参照）。
- claude.ai のログインセッションは Cookie として Electron の永続パーティション `persist:claudeai` に保存される（`settings.json` 等とは別の永続化先）。
- 公式取得結果は `officialUsage.ts` 内のモジュールスコープ変数で **60秒メモリキャッシュ**（`clearOfficialCache()` でログイン直後に破棄）。ディスクには保存しない。
- 設定の単一の真実は **main 側の `settingsStore`**。renderer・トレイ双方が `settings:set` / メニューハンドラ経由で更新し、`emitCurrent()`（ローカル値のみ再送）または `tick()`（`useOfficialUsage` 変更時。公式再取得を伴うため）で反映。

---

## 9. UI（renderer）

- `widget` ルートが半透明ダークカード（`styles.css` の CSS 変数で配色）。**3段構成**: `.term-header`（ターミナル風・信号ドット3つ＋`clawd@usage`＋点滅カーソル）→ `.body`（パネル群、`position:relative` で設定オーバーレイの土台）→ `.statusbar`（Clawdマスコット＋モード表示＋時刻）。
- ヘッダに `-webkit-app-region: drag`、ボタン・設定オーバーレイ・ログインボタン等の操作要素には全て `no-drag`（付け忘れるとクリックがドラッグに吸われる）。
- 設定パネルは `.settings-overlay`（`position:absolute; inset:0`）として **body の上に重ねる**。旧実装のようにパネル群の下に追加すると、開閉のたびにウィンドウ高さが変わってしまうため。
- ゲージ色は `fraction` で `ok(<0.7)/warn(<0.9)/danger(>=0.9)`（`LimitPanel.tsx` の `level()`）。`extras` も同じ `Gauge` コンポーネントで描画。
- `officialRequested && !official`（クラウード希望だが公式値が出ていない＝未ログイン/取得失敗）のとき `LimitPanel` にログイン促しボタンを表示。押すと `window.widget.loginClaude()` → IPC `claude:login` → `openClaudeLogin()`。
- `snap.status` が非 null のときは集計を出さずステータス文言を表示。
- CSP は `index.html` の meta で `default-src 'self'`（`unsafe-inline` は style のみ許可）。ログインウィンドウ（`officialUsage.openClaudeLogin`）は別の `BrowserWindow` で `contextIsolation:true` のみ・preload無し（claude.ai を素で表示するだけのため）。

---

## 10. 既知の制約・落とし穴（重要）

1. **エージェントサンドボックスで GUI 起動不可**: 実行環境が `ELECTRON_RUN_AS_NODE=1` を強制すると、Electron が browser プロセスではなく Node として動き `require('electron')` が機能せず `electron.app` が undefined になる。→ GUI 検証は**実機の `npm run dev` のみ**。集計ロジックは `npm run collect` や tsx で Electron 抜きに検証する。
2. **module ロード時に `app.getPath()` を呼ばない**: ストア生成は必ず `whenReady` 後。初版で top-level 生成して即クラッシュした（修正済み）。
3. **libuv の 8.3 短縮名クラッシュ**: `os.tmpdir()`（例 `C:\Users\RYOTAK~1\...`）配下を `fs.watch`/chokidar で監視すると libuv が `fs-event.c` でアサート失敗してクラッシュする。テストはロングパス配下で行う。実運用の `~/.claude` はロングパスなので影響なし。
4. **chokidar の `ready` 待ち**: `start()` 直後の追記を取りこぼさないよう `'ready'` を待つ（2秒フォールバック付き）。
5. **オフセットは非永続（メモリのみ）**: 起動毎に全ファイルをフルスキャンしてレコードを再構築する設計。時間ウィンドウ集計には7日分のレコードが要るため、オフセットだけ永続しても末尾からでは履歴を復元できない。フルスキャンは実測で数十ms（§12）なので許容。→ 計画当初の `~/.claude/.usage-widget-cache.json` 永続化は**未採用**。巨大化した場合の最適化は §11。
6. **`transparent: true` + Windows**: `backgroundColor:'#00000000'`、`hasShadow:false`、`ready-to-show` で表示。`resizable:false`（ユーザーのドラッグリサイズは無効）だが、**main プロセスが `applyWindowHeight()` で `setSize()` を呼び内容量に応じて高さを自動調整**する（コスト表示ON/OFF・公式extrasの数で変動）。renderer 側は高さを一切制御しない。
7. **`window-all-closed` で終了しない**: トレイ常駐が仕様。終了はトレイ「終了」または `app:quit`。
8. **【v0.3.0で発見・修正】dev実行でOSログイン時にElectronデモが起動するバグ**: `app.setLoginItemSettings({openAtLogin:true})` を dev/prod 問わず無条件に呼んでいたため、dev 実行時の `process.execPath`（素の `node_modules/electron/dist/electron.exe`）がそのまま Windows のスタートアップに登録されていた。次回 OS ログイン時、素の Electron バイナリが引数なしで起動 → **Electron 公式デモ（welcome画面）が表示される**。修正: `applyLoginItem(enabled)` ヘルパで `app.isPackaged` をチェックし、**dev では常に `openAtLogin:false` を送って stale 登録を能動的に掃除**する。3箇所あった直接呼び出し（起動時初期化・トレイトグル・IPC設定変更）を全てこのヘルパ経由に統一した。**既存の stale なスタートアップ登録は、修正後に一度 `npm run dev` を実行するまで残る**（コード修正だけでは自動的に消えない）。手動で消す場合はタスクマネージャ→スタートアップ→"Electron" を無効化。
9. **`useOfficialUsage` 既定ONの影響**: 初回起動時、未ログインなら claude.ai へのネットワーク呼び出しは行われない（`getOrgId()` が Cookie 無しで即 `null` を返し `fetchOfficialLimits` が早期リターンするため）。つまり「オフライン完結」という当初の前提は**既定では成立しなくなった**——ログイン後は claude.ai への定期通信が発生する（60秒キャッシュで頻度は抑制）。完全ローカル運用に戻したいユーザーは設定で `useOfficialUsage` をOFFにできる。

---

## 11. 拡張ポイント

- **公式レスポンスの実形状確定**: `officialUsage.mapUsage()` の extras 抽出・`labelFor()` のキー名マップは推測ベース（§13参照）。実機で一度 `console.debug(JSON.stringify(data))` を入れてレスポンスを確認し、既知キーの表を正としてハードコードし直すとより頑健になる。
- **完全ローカル運用の可視化**: `useOfficialUsage` をOFFにしたユーザー向けに、設定パネルへ「このモードでは通信しません」の一文を足すと安心材料になる。
- **オフセット永続化**: 起動が重くなった場合、7日分のレコードを `userData` にキャッシュし、起動時はキャッシュ＋差分読みに切替（§10-5 の代替）。
- **履歴グラフ**: `WindowAggregate` を日次で保持し、スパークラインを追加。
- **モデル別の内訳表示**: 現状は上位2モデル。展開UIで全モデル＋cache 内訳を表示可能。
- **単価の外部化**: `pricing.ts` の `RATES` を JSON 化し、claude-api スキルから自動更新。
- **Clawd のアニメーション**: 現状は静止SVG。公式取得中・エラー時などステータスに応じた簡易モーション（瞬き等）を追加できる。

---

## 12. 検証レシピ

### 集計の正しさ（Electron 不要）
```bash
npm run collect
```
`~/.claude/stats-cache.json` の日次モデル別トークンと、同一日の出力が概ね一致することを確認。実測: フルスキャン約30-75ms。**v0.3.0確認済み**: `claude-fable-5` 使用時に推定コストが 0 ではなく単価どおり計上されること（旧実装では単価未定義で$0に化けていた）。

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
確認項目:
- ターミナル風ヘッダ（信号ドット・`clawd@usage`・カーソル点滅）とステータスバー（Clawd・☁/⌂モード・時刻）が表示される。
- 初回起動時、未ログインなら「⌂ 推定」表示＋パネル内ログインボタン。トレイ/設定の「claude.ai にログイン」からログインすると「☁ 公式」に切り替わり、公式レスポンスに追加枠があれば自動で追加ゲージが増える（ウィンドウ高さも自動で伸びる）。
- 別ターミナルで Claude Code を1ターン動かし、数秒以内にトークン/コストが増えること。
- ドラッグ移動・位置保存・トレイ操作・最前面トグル・自動起動トグル・設定オーバーレイの開閉（高さが変わらないこと）を確認。
- **§10-8のバグ修正確認**: 一度 `npm run dev` した後、OSを再ログインしても Electron デモ画面が起動しないこと（要OS再ログイン、または `Get-ScheduledTask`/スタートアップフォルダで登録が無いことを確認）。

---

## 13. TODO / 未完了

- [ ] 実機での GUI 目視確認（サンドボックス制約で未実施。§10-1）。ターミナルUI・Clawd・ステータスバー・自動リサイズの見た目確認。
- [ ] **公式 `/usage` の実機動作確認・extras形状の確定**（`officialUsage.ts`）。方式は確定（claude.ai セッションCookie + `GET /api/organizations/{orgId}/usage`、レスポンス `{five_hour,seven_day}.utilization`）だが、**`five_hour`/`seven_day` 以外にどんなキーが実際に返るか（週Opus枠の実キー名など）は未検証**——`labelFor()` の対応表は推測。実機で一度レスポンスを確認して確定させる。要確認: ①ログイン窓で claude.ai にログイン→Cookie 永続、②`net.request` にセッションCookieが付き 200 で usage が返る、③Electron UA が弾かれないか。失敗時はローカル推定へフォールバックするので無害。
- [ ] **§10-8 のバグ修正の実機確認**: 修正後 `npm run dev` を実行→OS再ログインしてもElectronデモが出ないこと。
- [ ] 利用枠の基準値（5h=85M/週=430M、ローカル推定モード時のみ使用）は暫定。実利用データで既定を後調整。
- [ ] `applyWindowHeight()` の高さ計算式（258+58+extras*44）は概算。実機でextras表示時に余白/はみ出しが無いか調整。
- [ ] 自動アップデートの実機検証（インストーラ版で v を上げて配信→適用を確認）。GitHub の**下書きリリースを Publish** しないと updater は拾わない。
- [ ] アイコンの `.ico` 同梱（現状 256px PNG を electron-builder が変換）。
- [ ] 多モニタ環境での初期位置クランプ（画面外に出た保存位置の補正）。
- [ ] Clawd のアニメーション（§11）。
