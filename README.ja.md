[ Languages: [English](README.md) | **日本語** (Japanese) ]

# ContextDJ
<img src="public/icon-192x192.png" width="96" height="96" alt="ContextDJ Icon">

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Next.js](https://img.shields.io/badge/built%20with-Next.js-black)
![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-blue)

**ContextDJ** - AI Music Curator. 曖昧なリクエスト (例: "海を散歩したい気分に合う音楽を。23時からはピアノのJazzを聴きたいです。") を、完璧に構成された音楽スケジュールに変えるAI搭載のWebアプリケーションです。

単なるシャッフル再生やプレイリストとは異なり、ContextDJはラジオDJのように時間やムードの流れを理解し、その「文脈 (コンテキスト)」に沿ったスケジュールを構築します。

🌐 **今すぐ使う:** [contextdj.remoteroom.jp](https://contextdj.remoteroom.jp)

![ContextDJ QR Code](./docs/images/qr-contextdj.png)

![ContextDJ: リクエスト内容](./docs/images/screenshot_dj-0.png)
*(スクリーンショット: リクエスト内容を入力)*

![ContextDJ: リクエスト結果が反映された画面](./docs/images/screenshot_dj-1.png)
*(スクリーンショット: AIが生成した再生キューとメイン画面)*

## ✨ 主な機能

- **🎼 スマート・シーケンシング (起承転結)**: 各楽曲のエネルギー (1〜10)・推定BPM・セット内の役割 (`Intro` → `Build` → `Peak` → `Outro`) をAIが判定し、単なるシャッフルではなく本物のDJセットのような4段階のストーリー構成に自動並び替え。
- **⚓ アンカートラック & 楽曲精査 (AI Filtering)**: スケジュールごとにムードの核となる「象徴曲 (Anchor Tracks)」を設定。さらにSpotify検索結果の曲名・アーティスト名・**アルバム名**までAIが精査し、広告用BGM・カラオケ・オルゴール等のノイズを排除しつつ、指名されたアーティストの原曲を最優先で選曲。
- **✨ DJ INSIGHT & 選曲ノート**: AIが今何を考えてそのブロックを構成したかの思考プロセスに加え、1曲ごとの **Vibeタグ** (例: `#夕暮れチル`)、ステージ/エネルギー表示、ワンフレーズの**選曲理由**をリアルタイムに可視化 (上部の引用アイコンで表示切替可能)。
- **📸 Context Vision & 🎤 音声入力**: カメラで今見ている風景をDJに「見せる」ことでその場の情景や空気感に合う音楽を生成。多言語対応の**音声入力**によるハンズフリーのリクエストにも対応。
- **♻️ Context Recall & 個人の好み設定**: 過去の予定をワンタップで「召喚」してムードを再演・リミックス。さらに設定画面の **Personal Preferences (共通スタイル指示)** に好きなジャンルやこだわりを登録しておけば、毎回のリクエストに最優先の指示として自動反映。
- **🥣 自動おかわり機能 & 安定した再生同期**: 常に「文脈」を維持したまま、曲が少なくなると自動で次を提案する無限選曲。Spotify実再生状態との収束同期 (Convergence Sync) やトランジション保護、バックグラウンド省電力ポーリングにより安定した再生を実現。
- **🖥️ CLI / ターミナル版 (TUIダッシュボード)**: ターミナルや `tmux` 上で再生制御・進行状況・Vibeタグ・DJの思考確認・リクエスト送信が完結する対話型CUIを搭載。
- **🔒 プライバシー第一 (BYOK)**: サーバーを介さない設計。APIキーや履歴データはすべてブラウザ内 (CLI版はローカル設定ファイル) に完結し、外部サーバーへ送信されることはありません。

## 🚀 はじめ方

### 前提条件

ContextDJを利用するには、以下の準備が必要です (公開版・ローカル版共通):

1.  **Spotify Premium アカウント**: Web APIによる再生制御に必要です。
2.  **Spotify Client ID**: [Spotify Developer Dashboard](https://developer.spotify.com/dashboard/applications) でアプリを作成して取得します。
    - **APIs used**: **必ず `Web API` にチェックを入れて有効化してください** (⚠️ チェックが漏れると楽曲検索や再生制御が `QUOTA_EXCEEDED` や認可エラーで失敗します)。
    - **Redirect URIs**: ご利用の形態に合わせて以下を追加してください (複数登録可能・1つの Client ID で Web 版と CLI 版を兼用できます):
        - Web 公開版: `https://contextdj.remoteroom.jp/`
        - CLI / ターミナル版: `http://127.0.0.1:8888/callback`
        - ローカル Web 開発: `http://127.0.0.1:3000/`
3.  **AI APIキー**: [OpenAI](https://platform.openai.com) (デフォルトモデル: `gpt-5.4-mini`) または [Google AI Studio](https://aistudio.google.com/) (デフォルトモデル: `gemini-flash-latest`) のキー。

### セットアップ手順

1.  [contextdj.remoteroom.jp](https://contextdj.remoteroom.jp) にアクセスします。 ![ContextDJ: 初期画面](./docs/images/screenshot_start.png)
2.  右上の **設定 (⚙️)** アイコンをクリックします。 ![ContextDJ: 設定画面](./docs/images/screenshot_settings.png)
3.  **Spotify Client ID** を入力します。
4.  **AI Provider** (OpenAI または Google Gemini) を選択し、**AI API Key** を入力します (必要に応じてモデル名、音声認識言語、個人の好み設定などもカスタマイズ可能です)。
5.  **Save Configuration** をクリックします。
6.  ホーム画面に戻り、聴きたい気分のプロンプト（例: *"午後は明るいジャズで、夜は冬に似合うアカペラが聴きたい"*）をテキストまたは音声で入力して送信してください！

## 🛠️ 開発者向け

ローカル環境で実行する場合や、開発に貢献したい場合の手順です:

1.  **リポジトリのクローン**
    ```bash
    git clone https://github.com/mah-jp/context-dj.git
    cd context-dj
    ```

2.  **依存関係のインストール**
    ```bash
    yarn install
    ```

3.  **開発サーバーの起動**
    ```bash
    yarn dev
    ```

4.  ブラウザで [http://127.0.0.1:3000](http://127.0.0.1:3000) を開きます。

5.  **テスト・Lintの実行**
    ```bash
    yarn test
    yarn lint
    ```

## 🖥️ CLI / ターミナル版

ターミナルやヘッドレス環境 (`tmux` など) で手軽に操作・常駐できる CUI (TUI) 版も搭載されています。再生中の楽曲・プログレスバー・AIが付与したメタデータ (`Vibe` / `Energy` / `Stage` / `Reason`)・DJの思考・アクティブなスケジュールと象徴曲 (Anchors) をリアルタイムに可視化し、そのままリクエスト入力や再生操作が行えます。

### 起動方法

```bash
# 依存関係のインストール (初回のみ)
yarn install

# 対話型ダッシュボードの起動
yarn cli

# 起動と同時に音楽リクエストを送信
yarn cli "夜風に当たりながら聴きたいLo-Fiとアンビエント"

# 初回セットアップ・対話型設定ウィザードの実行
yarn cli setup

# 設定ファイルのパス表示 / ヘルプの表示
yarn cli --config
yarn cli --help
```

### 初回認証 (URL コピペ方式)
1. `yarn cli` を初回実行すると、ターミナルに Spotify 認可用の URL が表示されます。
2. ブラウザでその URL を開き、「承認」します。
3. リダイレクトされた URL (`http://127.0.0.1:8888/callback?code=...`) をアドレスバーからコピーし、ターミナルに貼り付けます。
4. 取得された `refresh_token` は `~/.config/context-dj/config.json` に安全に保存され、以降は完全自動でサイレント更新されます。

> [!IMPORTANT]
> **Spotify Client ID の注意点**:
> - アプリ作成時に **`Web API` が有効化されていること** を必ず確認してください (チェックが入っていないと曲の検索に失敗します)。
> - Web版で作成済みの Client ID がある場合、新しく作成しなくても既存アプリの「Settings」から Redirect URIs に `http://127.0.0.1:8888/callback` を追加するだけで共通利用できます。

### CUI 操作方法

* **リクエスト入力**:
  * `Enter`: リクエストを送信し、AI がスケジュールを自動生成して再生を開始。
  * `↑` / `↓`: **過去のリクエスト履歴（History）を呼び出し**。入力途中の下書きテキストも自動復元されます（履歴は `~/.config/context-dj/history.json` に自動永続化）。
* **クイック操作（入力欄が空のとき）**:
  * `Space`: 再生 / 一時停止
  * `n`: 次の曲へスキップ
  * `p`: 前の曲へ戻る
  * `q` または `Ctrl+C`: 終了

## 📦 技術スタック

- **フレームワーク**: [Next.js 16](https://nextjs.org/) (App Router, React 19, `@ducanh2912/next-pwa` によるPWA対応)
- **言語**: TypeScript
- **ターミナルUI**: [Ink](https://github.com/vadimdemedes/ink) (Reactベースの対話型CLI/TUI)
- **スタイリング**: CSS Modules (カスタムダークテーマ)
- **状態管理**: React Context API (再生状態・キュー/スケジュール・アクションの分割Context構成)
- **テスト・品質管理**: Node.js Test Runner (`tsx --test`), ESLint 9
- **パッケージマネージャー**: Yarn (`yarn@4.18.1`)
- **API**:
    - Spotify Web API (OAuth 2.0 PKCE)
    - OpenAI API / Google Gemini API
    - Web Speech API (音声入力)

## 📄 プライバシー通知

ContextDJは **クライアントサイド / ローカル完結型アプリケーション** です。
- 入力された機密性の高いAPIキーは、利用者のブラウザまたはローカルターミナルから直接各サービス (Spotify, OpenAI, Google) と通信するためだけに使用されます。
- **開発者のサーバーに利用者のデータが送信されることはありません。** すべての設定や履歴はブラウザの `localStorage` (CLI版は `~/.config/context-dj/`) にローカル保存されます。

## 🤝 ライセンス

本プロジェクトは MIT ライセンスの下で公開されています。詳細は [LICENSE](LICENSE) ファイルをご確認ください。
