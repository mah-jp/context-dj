# ContextDJ
<img src="public/icon-192x192.png" width="96" height="96" alt="ContextDJ Icon">

[English Version](./README.md)

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

- **🗣️ 自然言語インターフェース**: 聴きたい気分やシチュエーションをチャットで伝えるだけ。複雑なフィルタリングは不要です。
    - **🎙️ 音声入力対応**: テキストだけでなく、マイクボタンからの音声入力も可能です (設定画面で多言語対応)。
- **🧠 AIによる選曲**: **OpenAI (GPT-4o)** および **Google Gemini** モデルをサポートし、ニュアンスや音楽的文脈を深く理解します。
- **🎯 楽曲精査 (AI Filtering)**: (実験的機能) Spotifyで検索された楽曲が、リクエスト内容やDJの意図に本当に合致しているかをAIが判定し、無関係な曲を除外します。**デフォルトで有効**になっており、選曲の質を大幅に向上させます。
- **🔒 プライバシーファースト**: **Bring Your Own Key (BYOK)** アーキテクチャを採用。APIキー (OpenAI/Gemini/Spotify) は、すべて**利用者のブラウザ内にローカル保存**されます。開発者が利用者のデータを見ることはありません。
- **🌊 シームレスなSpotify連携**: Webブラウザ上でSpotify Premiumアカウントと連携し、ContextDJが選曲したプレイリストをあなたのデバイス (スマホやPCのSpotifyアプリ) で再生します。

## 🚀 はじめ方

### 前提条件

ContextDJを利用するには、以下の準備が必要です (公開版・ローカル版共通):

1.  **Spotify Premium アカウント**: Web APIによる再生制御に必要です。
2.  **Spotify Client ID**: [Spotify Developer Dashboard](https://developer.spotify.com/dashboard/applications) で簡単なアプリを作成して取得します。
    - Redirect URIs: `https://contextdj.remoteroom.jp/` (ローカル開発の場合は `http://127.0.0.1:3000/`)
    - APIs used: `Web API`
3.  **AI APIキー**: [OpenAI](https://platform.openai.com) または [Google AI Studio](https://aistudio.google.com/) のキー。

### セットアップ手順

1.  [contextdj.remoteroom.jp](https://contextdj.remoteroom.jp) にアクセスします。 ![ContextDJ: 初期画面](./docs/images/screenshot_start.png)
2.  右上の **設定 (⚙️)** アイコンをクリックします。 ![ContextDJ: 設定画面](./docs/images/screenshot_settings.png)
3.  **Spotify Client ID** を入力します。
4.  **AI API Key** (OpenAI または Gemini) を入力します。
5.  **Save Configuration** をクリックします。
6.  ホーム画面に戻り、聴きたい気分のプロンプト（例: *"午後は明るいジャズで、夜は冬に似合うアカペラが聴きたい"*）を入力して送信してください！

## 🛠️ 開発者向け

ローカル環境で実行する場合や、開発に貢献したい場合の手順です:

1.  **リポジトリのクローン**
    ```bash
    git clone https://github.com/mah-jp/context-dj.git
    cd context-dj
    ```

2.  **依存関係のインストール**
    ```bash
    npm install
    # または
    yarn install
    ```

3.  **開発サーバーの起動**
    ```bash
    npm run dev
    ```

4.  ブラウザで [http://127.0.0.1:3000](http://127.0.0.1:3000) を開きます。

## 📦 技術スタック

- **フレームワーク**: [Next.js](https://nextjs.org/) (App Router)
- **言語**: TypeScript
- **スタイリング**: CSS Modules (カスタムダークテーマ)
- **状態管理**: React Context API
- **API**:
    - Spotify Web API
    - OpenAI API / Google Gemini API

## 📄 プライバシー通知

ContextDJは **クライアントサイド・アプリケーション** です。
- 入力された機密性の高いAPIキーは、利用者のブラウザから直接各サービス (Spotify, OpenAI, Google) と通信するためだけに使用されます。
- **開発者のサーバーに利用者のデータが送信されることはありません。** すべての設定はブラウザの `localStorage` に保存されます。

## 🤝 ライセンス

本プロジェクトは MIT ライセンスの下で公開されています。詳細は [LICENSE](LICENSE) ファイルをご確認ください。
