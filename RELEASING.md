# リリース手順（メンテナ向け）

GitHub Releases に `.exe` を公開し、既存ユーザーへ自動アップデートを配信するまでの手順。

配布先リポジトリ: **`Ryo-Shihakata/Claude-Usage-Widget-Win`**（public）

---

## 前提（初回のみ）

- Node.js 20+ / `npm install` 済み。
- `gh` で GitHub にログイン済み（`gh auth status` で確認）。
- **Windows の「開発者モード」をON**にする（設定 → プライバシーとセキュリティ → 開発者向け）。
  electron-builder が `winCodeSign` キャッシュを展開する際に**シンボリックリンク作成**が必要で、開発者モードOFFだと
  `Cannot create symbolic link ... 必要な特権を保有していません` で失敗する。管理者ターミナルでも可。

---

## リリース手順

### 1. バージョンを上げる
`package.json` の `version` を [semver](https://semver.org/lang/ja/) で上げる（例 `0.2.0` → `0.2.1`）。
**必ず上げること。** 同じバージョンのままだと electron-updater が更新を検知しない。
リリースタグは electron-builder が `v{version}`（例 `v0.2.1`）で作成する。

### 2. ビルドが通るか確認
```bash
npm run typecheck
npm run build
```

### 3. ビルドして GitHub にアップロード（下書きリリース作成）
```bash
GH_TOKEN=$(gh auth token) npm run release
```
electron-builder が `release/` に成果物を作り、**下書きリリース**へアップロードする:
- `Claude Usage Widget Setup {version}.exe` … NSIS インストーラ
- `ClaudeUsageWidget-portable-{version}.exe` … ポータブル
- `latest.yml` … **自動アップデートに必須**（electron-updater がこれを見て更新判定）
- `*.blockmap` … 差分ダウンロード用

> ローカル確認だけしたい場合は `npm run package`（アップロードなし、`release/` に生成のみ）。

### 4. リリースを公開（Publish）
GitHub の Releases → 作成された**下書き**を開く → タグ/タイトル（`v{version}`）を確認 →
本文に下記「リリース文言」を貼る → **Publish release**。

> ⚠️ 下書きのままだと **配布もできず、自動アップデートも効かない**（updater は公開済みリリースのみ参照）。

### 5. 動作確認
- Releases ページから `Setup.exe` をDLしてインストール → 起動を確認。
- 自動アップデート: 旧バージョンを入れた状態で新バージョンを公開 → 旧アプリ起動後 数秒〜6時間以内に
  バックグラウンドDL → 次回終了時に自動適用（DL完了時にOS通知）。

---

## 補足・注意

- **未署名アプリ**: 初回起動で SmartScreen 警告（「詳細情報」→「実行」で回避）。正式配布で警告を消すには
  有料のコードサイニング証明書が必要（任意）。
- **ポータブル版は自動アップデート対象外**（手動で入れ替え）。自動更新はインストーラ版のみ。
- **`latest.yml` を消さない**: リリースアセットから消すと updater が動かなくなる。
- **ロールバック**: 問題があれば該当リリースを Delete するか、前バージョンを最新（latest）に戻す。
- リポジトリ設定は `package.json` の `build.publish`（provider: github / owner / repo）と `repository` フィールド。

---

## 今回のリリース文言（v0.2.0）

> GitHub Release の本文にそのまま貼れます。

```markdown
## Claude Usage Widget v0.2.0

Claude Code の使用量をデスクトップに常時表示するフローティングウィジェット（Windows）の初回公開リリースです。画面の片隅で「5時間枠・週間枠をどれだけ使ったか／今日のトークン・コスト」を常に確認できます。

### ✨ 主な機能
- **利用枠ゲージ（5時間 / 1週間）** — Claude のレート制限に対応する2枠を色付きゲージ（コーラル→黄→赤）で表示。基準値は設定で調整可。
- **トレイのリングゲージ** — 最小化中もタスクトレイのアイコンで消費率が一目で分かる（ホバーで `5時間: X% / 1週間: Y%`）。
- **今日のトークン / 推定コスト(USD)** — モデル別トークン・メッセージ/セッション数、公開単価換算の参考コスト。
- **公式 /usage 連携（実験的・任意）** — claude.ai にログインすると公式の利用率に切替。既定OFF、取得失敗時はローカル推定へ自動フォールバック。
- **自動更新** — Claude Code の応答を数秒で反映（ファイル監視＋ポーリング、ネットワーク不要）。
- **自動起動（既定ON）/ 常に最前面 / ドラッグ移動・位置記憶**。
- **自動アップデート対応**（インストーラ版）。Claude Code 風の暖色ダーク＋コーラルのデザイン。

### 📥 インストール
下の **Assets** からダウンロード（Node.js 不要）:
- `Claude Usage Widget Setup 0.2.0.exe` … インストーラ（推奨・自動アップデート対応）
- `ClaudeUsageWidget-portable-0.2.0.exe` … インストール不要のポータブル版

> 未署名のため初回は SmartScreen 警告が出ます →「詳細情報」→「実行」。

### ⚠️ 注意
- 利用枠は既定では **ローカルログからの推定** です（公式 /usage はオプトイン）。
- 公式 /usage は claude.ai の非公開Web APIに依存するため、仕様変更で動かなくなる可能性があります。
```
