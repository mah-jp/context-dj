'use client';

import { useState } from 'react';
import Link from 'next/link';
import styles from './page.module.css';
import { SpotifyAuth } from '../../lib/spotify-auth';
import { STORAGE_KEYS, DEFAULT_MODELS, DEFAULTS } from '../../lib/constants';
import { AIProvider } from '../../lib/types';
import { getStorageItem, setStorageItem, removeStorageItem, getStoredJSON, setStoredJSON } from '../../lib/storage';
import { usePlayer } from '../../context/PlayerContext';
import PrivacyNotice from '../../components/PrivacyNotice';
import { ArrowLeft, Github } from 'lucide-react';

export default function Settings() {
    const { reloadConfig } = usePlayer();

    const [spotifyClientId, setSpotifyClientId] = useState(() => getStorageItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID, ''));
    const [openAiKey, setOpenAiKey] = useState(() => getStorageItem(STORAGE_KEYS.OPENAI_API_KEY, ''));
    const [openAiModel, setOpenAiModel] = useState(() => getStorageItem(STORAGE_KEYS.OPENAI_MODEL, DEFAULT_MODELS.OPENAI));
    const [geminiKey, setGeminiKey] = useState(() => getStorageItem(STORAGE_KEYS.GEMINI_API_KEY, ''));
    const [geminiModel, setGeminiModel] = useState(() => getStorageItem(STORAGE_KEYS.GEMINI_MODEL, DEFAULT_MODELS.GEMINI));
    const [aiProvider, setAiProvider] = useState<AIProvider>(() => {
        const savedProvider = getStorageItem(STORAGE_KEYS.SELECTED_AI_PROVIDER, '') as AIProvider;
        return savedProvider === 'gemini' ? 'gemini' : 'openai';
    });
    const [status, setStatus] = useState('');
    const [personalPref, setPersonalPref] = useState(() => getStorageItem(STORAGE_KEYS.PERSONAL_PREFERENCE, ''));
    const [prefHistory, setPrefHistory] = useState<string[]>(() => getStoredJSON<string[]>(STORAGE_KEYS.PERSONAL_PREFERENCE_HISTORY, []));
    const [showPrefHistory, setShowPrefHistory] = useState(false);
    const [voiceLang, setVoiceLang] = useState<string>(() => {
        const defaultLang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : DEFAULTS.VOICE_LANG;
        return getStorageItem(STORAGE_KEYS.VOICE_INPUT_LANG, defaultLang);
    });
    const [backgroundKeepAlive, setBackgroundKeepAlive] = useState<boolean>(
        () => getStorageItem(STORAGE_KEYS.BACKGROUND_KEEP_ALIVE, '') === 'true'
    );
    const [aiFilteringEnabled, setAiFilteringEnabled] = useState<boolean>(() => {
        const savedFiltering = getStorageItem(STORAGE_KEYS.AI_FILTERING_ENABLED, '');
        return savedFiltering === '' ? DEFAULTS.AI_FILTERING_ENABLED : savedFiltering === 'true';
    });

    const handleSave = () => {
        setStorageItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID, spotifyClientId);
        setStorageItem(STORAGE_KEYS.OPENAI_API_KEY, openAiKey);
        setStorageItem(STORAGE_KEYS.OPENAI_MODEL, openAiModel);
        setStorageItem(STORAGE_KEYS.GEMINI_API_KEY, geminiKey);
        setStorageItem(STORAGE_KEYS.GEMINI_MODEL, geminiModel);
        setStorageItem(STORAGE_KEYS.SELECTED_AI_PROVIDER, aiProvider);
        setStorageItem(STORAGE_KEYS.PERSONAL_PREFERENCE, personalPref);
        setStorageItem(STORAGE_KEYS.VOICE_INPUT_LANG, voiceLang);
        setStorageItem(STORAGE_KEYS.BACKGROUND_KEEP_ALIVE, String(backgroundKeepAlive));
        setStorageItem(STORAGE_KEYS.AI_FILTERING_ENABLED, String(aiFilteringEnabled));

        if (personalPref.trim()) {
            const newHistory = [personalPref, ...prefHistory.filter(h => h !== personalPref)].slice(0, 10);
            setPrefHistory(newHistory);
            setStoredJSON(STORAGE_KEYS.PERSONAL_PREFERENCE_HISTORY, newHistory);
        }

        reloadConfig();

        setStatus('Settings saved! (設定を保存しました)');
        setTimeout(() => setStatus(''), 3000);
    };

    const handleLogout = () => {
        if (confirm('Are you sure you want to log out from Spotify?\n(Spotifyからログアウトしますか？)')) {
            SpotifyAuth.logout();
            reloadConfig();
            setStatus('Logged out from Spotify. (ログアウトしました)');
            setTimeout(() => setStatus(''), 3000);
        }
    };

    return (
        <div className={styles.container}>
            <header className={styles.header}>
                <Link href="/" className={styles.backLink}>
                    <ArrowLeft size={20} />
                    Back
                </Link>
                <h1 className={styles.title}>Settings</h1>
                <a
                    href="https://github.com/mah-jp/context-dj"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.githubLink}
                >
                    <Github size={16} />
                    <span>View Source on GitHub</span>
                </a>
            </header>

            <div className={styles.section}>
                <h2 className={styles.sectionTitle}>Spotify Configuration</h2>
                <div className={styles.inputGroup}>
                    <label className={styles.label}>
                        Client ID
                        <span className={styles.subLabel}>クライアントID</span>
                    </label>
                    <input
                        type="text"
                        className={styles.input}
                        value={spotifyClientId}
                        onChange={(e) => setSpotifyClientId(e.target.value)}
                        placeholder="Your Spotify App Client ID"
                    />
                    <p className={styles.description}>
                        Required for playback. Create an app at <a href="https://developer.spotify.com/dashboard" target="_blank" className={styles.primaryLink}>developer.spotify.com</a><br />
                        <span className={styles.subDescription}>音楽再生に必要です。公式サイトでアプリを作成しIDを取得してください。</span>
                    </p>
                    <button
                        onClick={handleLogout}
                        className={styles.disconnectBtn}
                    >
                        Disconnect Spotify Session <span style={{ fontSize: '0.8em' }}>(切断)</span>
                    </button>
                </div>
            </div>

            <div className={styles.section}>
                <h2 className={styles.sectionTitle}>AI Configuration</h2>

                <PrivacyNotice />

                <div className={styles.inputGroup}>
                    <label className={styles.label}>
                        Select AI Provider
                        <span className={styles.subLabel}>AIプロバイダーの選択</span>
                    </label>
                    <div className={styles.radioGroup}>
                        <label className={styles.radioLabel}>
                            <input
                                type="radio"
                                name="aiProvider"
                                value="openai"
                                checked={aiProvider === 'openai'}
                                onChange={() => setAiProvider('openai')}
                                className={styles.radioInput}
                            />
                            OpenAI
                        </label>
                        <label className={styles.radioLabel}>
                            <input
                                type="radio"
                                name="aiProvider"
                                value="gemini"
                                checked={aiProvider === 'gemini'}
                                onChange={() => setAiProvider('gemini')}
                                className={styles.radioInput}
                            />
                            Google Gemini
                        </label>
                    </div>
                </div>

                {aiProvider === 'openai' && (
                    <>
                        <div className={styles.inputGroup}>
                            <label className={styles.label}>
                                OpenAI API Key
                                <span className={styles.subLabel}>OpenAI APIキー</span>
                            </label>
                            <input
                                type="password"
                                className={styles.input}
                                value={openAiKey}
                                onChange={(e) => setOpenAiKey(e.target.value)}
                                placeholder="sk-..."
                            />
                            <p className={styles.description}>
                                Create an ID at <a href="https://platform.openai.com/api-keys" target="_blank" className={styles.primaryLink}>platform.openai.com</a><br />
                                <span className={styles.subDescription}>上記サイトでAPIキーを作成してください。</span>
                            </p>
                        </div>
                        <div className={styles.inputGroup}>
                            <label className={styles.label}>
                                OpenAI Model Name
                                <span className={styles.subLabel}>モデル名 (任意)</span>
                            </label>
                            <input
                                type="text"
                                className={styles.input}
                                value={openAiModel}
                                onChange={(e) => setOpenAiModel(e.target.value)}
                                placeholder={DEFAULT_MODELS.OPENAI}
                            />
                            <p className={styles.description}>
                                Optional. Default: {DEFAULT_MODELS.OPENAI}.<br />
                                <span className={styles.subDescription}>指定がない場合は {DEFAULT_MODELS.OPENAI} が使用されます。</span>
                            </p>
                        </div>
                    </>
                )}

                {aiProvider === 'gemini' && (
                    <>
                        <div className={styles.inputGroup}>
                            <label className={styles.label}>
                                Google Gemini API Key
                                <span className={styles.subLabel}>Google Gemini APIキー</span>
                            </label>
                            <input
                                type="password"
                                className={styles.input}
                                value={geminiKey}
                                onChange={(e) => setGeminiKey(e.target.value)}
                                placeholder="AIza..."
                            />
                            <p className={styles.description}>
                                Create an ID at <a href="https://aistudio.google.com/app/api-keys" target="_blank" className={styles.primaryLink}>aistudio.google.com</a><br />
                                <span className={styles.subDescription}>上記サイトでAPIキーを作成してください。</span>
                            </p>
                        </div>
                        <div className={styles.inputGroup}>
                            <label className={styles.label}>
                                Gemini Model Name
                                <span className={styles.subLabel}>モデル名 (任意)</span>
                            </label>
                            <input
                                type="text"
                                className={styles.input}
                                value={geminiModel}
                                onChange={(e) => setGeminiModel(e.target.value)}
                                placeholder={DEFAULT_MODELS.GEMINI}
                            />
                            <p className={styles.description}>
                                Optional. Default: {DEFAULT_MODELS.GEMINI}. See <a href="https://ai.google.dev/models/gemini" target="_blank" className={styles.primaryLink}>Gemini Models</a>.<br />
                                <span className={styles.subDescription}>指定がない場合は {DEFAULT_MODELS.GEMINI} が使用されます。</span>
                            </p>
                        </div>
                    </>
                )}
            </div>

            <div className={styles.section}>
                <h2 className={styles.sectionTitle}>Voice Input Settings</h2>
                <div className={styles.inputGroup}>
                    <label className={styles.label}>
                        Recognition Language
                        <span className={styles.subLabel}>音声認識の言語</span>
                    </label>
                    <select
                        className={`${styles.input} ${styles.selectInput}`}
                        value={voiceLang}
                        onChange={(e) => setVoiceLang(e.target.value)}
                    >
                        <option value="ja-JP">Japanese (日本語)</option>
                        <option value="en-US">English (US)</option>
                        <option value="en-GB">English (UK)</option>
                        <option value="es-ES">Spanish (Español)</option>
                        <option value="fr-FR">French (Français)</option>
                        <option value="de-DE">German (Deutsch)</option>
                        <option value="ko-KR">Korean (한국어)</option>
                        <option value="zh-CN">Chinese (Simplified) (简体中文)</option>
                    </select>
                    <p className={styles.description}>
                        Select the language for voice input. Default: Browser/OS setting if available, otherwise Japanese.<br />
                        <span className={styles.subDescription}>音声入力で使用する言語を選択してください。</span>
                    </p>
                </div>
            </div>

            <div className={styles.section}>
                <h2 className={styles.sectionTitle}>
                    Personal Preferences
                    <span className={styles.sectionSubTitle}>個人の好み・設定 (Personal Preferences)</span>
                </h2>
                <div className={styles.inputGroup}>
                    <label className={styles.label}>
                        Universal Style Instructions
                        <span className={styles.subLabel}>共通スタイル指示 (毎回AIへの指示に追加されます)</span>
                        <button
                            onClick={() => setShowPrefHistory(!showPrefHistory)}
                            className={styles.historyToggleBtn}
                        >
                            History (履歴)
                        </button>
                    </label>

                    {showPrefHistory && prefHistory.length > 0 && (
                        <div className={styles.prefHistoryDropdown}>
                            {prefHistory.map((h, i) => (
                                <div
                                    key={`${h}-${i}`}
                                    onClick={() => {
                                        setPersonalPref(h);
                                        setShowPrefHistory(false);
                                    }}
                                    className={styles.prefHistoryItem}
                                >
                                    {h.slice(0, 60)}...
                                </div>
                            ))}
                        </div>
                    )}

                    <textarea
                        className={`${styles.input} ${styles.textareaInput}`}
                        value={personalPref}
                        onChange={(e) => setPersonalPref(e.target.value)}
                        placeholder="e.g. I generally prefer 90s rock. I love live recordings. / 例: 基本的に90年代ロックが好き。ライブ音源は大好きです。"
                    />
                    <p className={styles.description}>
                        These preferences will be appended to the AI prompt as high-priority instructions for every request.<br />
                        <span className={styles.subDescription}>ここで設定した内容は、AIへのリクエストの際に「最優先の指示」として常に追加されます。</span>
                    </p>
                </div>
            </div>

            <div className={styles.section}>
                <h2 className={styles.sectionTitle}>
                    Experimental Features
                    <span className={styles.sectionSubTitle}>実験的機能</span>
                </h2>

                <div className={styles.inputGroup}>
                    <label className={styles.checkboxLabel}>
                        <input
                            type="checkbox"
                            checked={aiFilteringEnabled}
                            onChange={(e) => setAiFilteringEnabled(e.target.checked)}
                            className={styles.checkboxInput}
                        />
                        <span>
                            AI Filtering / Smart Selection (AIによる選曲フィルタリング)
                        </span>
                    </label>
                    <p className={styles.description}>
                        Uses AI to verify if searched tracks match your request. Improves quality but adds about 30 seconds delay to search.<br />
                        <span className={styles.subDescription}>検索された曲がリクエストに合っているかAIが判定し、無関係な曲を除外します。精度が向上しますが、検索時に約30秒の待ち時間が発生します。</span>
                    </p>
                </div>
                <div className={styles.inputGroup}>
                    <label className={styles.checkboxLabel}>
                        <input
                            type="checkbox"
                            checked={backgroundKeepAlive}
                            onChange={(e) => setBackgroundKeepAlive(e.target.checked)}
                            className={styles.checkboxInput}
                        />
                        <span>
                            Run in Background (Keep Alive)
                        </span>
                    </label>
                    <p className={styles.description}>
                        Plays a silent audio loop to keep the app running when screen is off.
                        <br />
                        <b>Warning:</b> This may stop music playback if you are listening on the <b>same device</b> (due to Audio Focus). Recommended only when controlling a separate device (PC, Alexa, etc).
                        <br />
                        <span className={styles.subDescription}>
                            画面消灯時もアプリを動作させ続けるため、無音の音声をループ再生します。<br />
                            <b>注意:</b> <b>同じ端末</b>で音楽を聴いている場合、再生が止まることがあります (オーディオ権限の競合)。PCやスマートスピーカーを操作する場合にのみ推奨します。
                        </span>
                    </p>
                </div>
            </div>

            <div className={styles.section}>
                <h2 className={styles.sectionTitle}>Data Management</h2>
                <div className={styles.inputGroup}>
                    <p className={styles.description}>
                        Manage your locally stored history data.<br />
                        <span className={styles.subDescription}>ブラウザに保存された履歴データを管理します。</span>
                    </p>
                    <div className={styles.dangerButtonGroup}>
                        <button
                            onClick={() => {
                                if (confirm('Are you sure you want to clear the main chat prompt history?\n(チャット履歴を削除しますか？)')) {
                                    removeStorageItem(STORAGE_KEYS.PROMPT_HISTORY);
                                    setStatus('Chat history cleared! (チャット履歴を削除しました)');
                                    setTimeout(() => setStatus(''), 3000);
                                }
                            }}
                            className={styles.dangerBtn}
                        >
                            Clear Chat History<br />
                            <span style={{ fontSize: '0.8em' }}>(チャット履歴削除)</span>
                        </button>

                        <button
                            onClick={() => {
                                if (confirm('Are you sure you want to clear your personal preferences history?\n(設定履歴を削除しますか？)')) {
                                    removeStorageItem(STORAGE_KEYS.PERSONAL_PREFERENCE_HISTORY);
                                    setPrefHistory([]);
                                    setStatus('References history cleared! (設定履歴を削除しました)');
                                    setTimeout(() => setStatus(''), 3000);
                                }
                            }}
                            className={`${styles.dangerBtn} ${styles.dangerBtnDark}`}
                        >
                            Clear Preferences History<br />
                            <span style={{ fontSize: '0.8em' }}>(設定履歴削除)</span>
                        </button>
                    </div>
                </div>
            </div>

            <div className={styles.statusArea}>
                {status && <span>{status}</span>}
            </div>

            <button className={styles.saveBtn} onClick={handleSave}>
                Save Configuration <span style={{ fontSize: '0.8em', marginLeft: '4px' }}>(保存)</span>
            </button>

            <div className={styles.footerVersion}>
                ContextDJ v{process.env.NEXT_PUBLIC_APP_VERSION}
            </div>
        </div>
    );
}
