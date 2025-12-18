'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import styles from './page.module.css';
import { SpotifyAuth } from '../../lib/spotify-auth';
import { STORAGE_KEYS, PRIVACY_NOTICE } from '../../lib/constants';
import { ArrowLeft, Github } from 'lucide-react';

export default function Settings() {
    const [spotifyClientId, setSpotifyClientId] = useState('');
    const [openAiKey, setOpenAiKey] = useState('');
    const [openAiModel, setOpenAiModel] = useState('');
    const [geminiKey, setGeminiKey] = useState('');
    const [geminiModel, setGeminiModel] = useState('');
    const [aiProvider, setAiProvider] = useState<'openai' | 'gemini'>('openai');
    const [status, setStatus] = useState('');
    const [personalPref, setPersonalPref] = useState('');
    const [prefHistory, setPrefHistory] = useState<string[]>([]);
    const [showPrefHistory, setShowPrefHistory] = useState(false);
    const [voiceLang, setVoiceLang] = useState('ja-JP'); // default to Japanese :-)
    const [backgroundKeepAlive, setBackgroundKeepAlive] = useState(false);

    useEffect(() => {
        // Load from local storage
        if (typeof window !== 'undefined') {
            setSpotifyClientId(localStorage.getItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID) || '');
            setOpenAiKey(localStorage.getItem(STORAGE_KEYS.OPENAI_API_KEY) || '');
            setOpenAiModel(localStorage.getItem(STORAGE_KEYS.OPENAI_MODEL) || 'gpt-4o-mini');
            setGeminiKey(localStorage.getItem(STORAGE_KEYS.GEMINI_API_KEY) || '');
            setGeminiModel(localStorage.getItem(STORAGE_KEYS.GEMINI_MODEL) || 'gemini-2.5-flash');

            setVoiceLang(localStorage.getItem(STORAGE_KEYS.VOICE_INPUT_LANG) || navigator.language || 'ja-JP');

            const savedProvider = localStorage.getItem(STORAGE_KEYS.SELECTED_AI_PROVIDER);
            if (savedProvider === 'gemini') {
                setAiProvider('gemini');
            } else {
                setAiProvider('openai');
            }

            setPersonalPref(localStorage.getItem(STORAGE_KEYS.PERSONAL_PREFERENCE) || '');
            try {
                // personal_pref_history is not in STORAGE_KEYS yet? 
                // Wait, I should stick to what's defined or add it. I will skip this one if not defined.
                // Ah, I intended to add it but didn't write to file yet.
                // I will use literal string for now for history or add it.
                // Let's stick to literal for history to avoid error if I forget to add it.
                const savedHistory = localStorage.getItem('personal_pref_history');
                if (savedHistory) setPrefHistory(JSON.parse(savedHistory));
            } catch (e) { console.error("History parse fail", e); }

            // Default false to avoid surprise, or true? User requested it, so let's default false and let them enable.
            setBackgroundKeepAlive(localStorage.getItem(STORAGE_KEYS.BACKGROUND_KEEP_ALIVE) === 'true');
        }
    }, []);

    const handleSave = () => {
        localStorage.setItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID, spotifyClientId);
        localStorage.setItem(STORAGE_KEYS.OPENAI_API_KEY, openAiKey);
        localStorage.setItem(STORAGE_KEYS.OPENAI_MODEL, openAiModel);
        localStorage.setItem(STORAGE_KEYS.GEMINI_API_KEY, geminiKey);
        localStorage.setItem(STORAGE_KEYS.GEMINI_MODEL, geminiModel);
        localStorage.setItem(STORAGE_KEYS.SELECTED_AI_PROVIDER, aiProvider);
        // duplicate line removed from original: localStorage.setItem('selected_ai_provider', aiProvider);
        localStorage.setItem(STORAGE_KEYS.PERSONAL_PREFERENCE, personalPref);
        localStorage.setItem(STORAGE_KEYS.VOICE_INPUT_LANG, voiceLang);
        localStorage.setItem(STORAGE_KEYS.BACKGROUND_KEEP_ALIVE, String(backgroundKeepAlive));

        // Update history if new unique entry
        if (personalPref.trim()) {
            const newHistory = [personalPref, ...prefHistory.filter(h => h !== personalPref)].slice(0, 10);
            setPrefHistory(newHistory);
            localStorage.setItem('personal_pref_history', JSON.stringify(newHistory));
        }

        setStatus('Settings saved! (設定を保存しました)');
        setTimeout(() => setStatus(''), 3000);
    };

    const handleLogout = () => {
        if (confirm('Are you sure you want to log out from Spotify?\n(Spotifyからログアウトしますか？)')) {
            SpotifyAuth.logout();
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
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        textDecoration: 'none',
                        color: '#888',
                        fontSize: '0.9rem',
                        marginLeft: '16px',
                        marginTop: '4px'
                    }}
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
                        <span style={{ display: 'block', fontSize: '0.8em', fontWeight: 'normal', color: '#888' }}>クライアントID</span>
                    </label>
                    <input
                        type="text"
                        className={styles.input}
                        value={spotifyClientId}
                        onChange={(e) => setSpotifyClientId(e.target.value)}
                        placeholder="Your Spotify App Client ID"
                    />
                    <p className={styles.description}>
                        Required for playback. Create an app at <a href="https://developer.spotify.com/dashboard" target="_blank" style={{ color: 'var(--primary)' }}>developer.spotify.com</a><br />
                        <span style={{ fontSize: '0.9em', color: '#999' }}>音楽再生に必要です。公式サイトでアプリを作成しIDを取得してください。</span>
                    </p>
                    <button
                        onClick={handleLogout}
                        style={{
                            background: 'transparent',
                            border: '1px solid #cf6679',
                            color: '#cf6679',
                            padding: '8px 16px',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            marginTop: '12px',
                            fontSize: '0.85rem'
                        }}
                    >
                        Disconnect Spotify Session <span style={{ fontSize: '0.8em' }}>(切断)</span>
                    </button>
                </div>
            </div>

            <div className={styles.section}>
                <h2 className={styles.sectionTitle}>AI Configuration</h2>

                <div style={{ padding: '12px', background: 'rgba(3, 218, 198, 0.1)', borderLeft: '4px solid #03dac6', marginBottom: '20px', borderRadius: '4px' }}>
                    <p style={{ margin: 0, fontSize: '0.9rem', color: '#eee' }}>
                        🔒 <b>Privacy Notice (プライバシー通知):</b><br />
                        <span dangerouslySetInnerHTML={{ __html: PRIVACY_NOTICE.EN.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>') }} />
                        <br /><br />
                        <span dangerouslySetInnerHTML={{ __html: PRIVACY_NOTICE.JP.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>') }} />
                    </p>
                </div>

                <div className={styles.inputGroup}>
                    <label className={styles.label} style={{ marginBottom: '10px', display: 'block' }}>
                        Select AI Provider
                        <span style={{ display: 'block', fontSize: '0.8em', fontWeight: 'normal', color: '#888' }}>AIプロバイダーの選択</span>
                    </label>
                    <div style={{ display: 'flex', gap: '20px', marginBottom: '16px' }}>
                        <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', fontSize: '1rem' }}>
                            <input
                                type="radio"
                                name="aiProvider"
                                value="openai"
                                checked={aiProvider === 'openai'}
                                onChange={() => setAiProvider('openai')}
                                style={{ marginRight: '8px', accentColor: 'var(--primary)', transform: 'scale(1.2)' }}
                            />
                            OpenAI
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', fontSize: '1rem' }}>
                            <input
                                type="radio"
                                name="aiProvider"
                                value="gemini"
                                checked={aiProvider === 'gemini'}
                                onChange={() => setAiProvider('gemini')}
                                style={{ marginRight: '8px', accentColor: 'var(--primary)', transform: 'scale(1.2)' }}
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
                                <span style={{ display: 'block', fontSize: '0.8em', fontWeight: 'normal', color: '#888' }}>OpenAI APIキー</span>
                            </label>
                            <input
                                type="password"
                                className={styles.input}
                                value={openAiKey}
                                onChange={(e) => setOpenAiKey(e.target.value)}
                                placeholder="sk-..."
                            />
                            <p className={styles.description}>
                                Create an ID at <a href="https://platform.openai.com/api-keys" target="_blank" style={{ color: 'var(--primary)' }}>platform.openai.com</a><br />
                                <span style={{ fontSize: '0.9em', color: '#999' }}>上記サイトでAPIキーを作成してください。</span>
                            </p>
                        </div>
                        <div className={styles.inputGroup}>
                            <label className={styles.label}>
                                OpenAI Model Name
                                <span style={{ display: 'block', fontSize: '0.8em', fontWeight: 'normal', color: '#888' }}>モデル名 (任意)</span>
                            </label>
                            <input
                                type="text"
                                className={styles.input}
                                value={openAiModel}
                                onChange={(e) => setOpenAiModel(e.target.value)}
                                placeholder="gpt-4o-mini"
                            />
                            <p className={styles.description}>
                                Optional. Default: gpt-4o-mini.<br />
                                <span style={{ fontSize: '0.9em', color: '#999' }}>指定がない場合は gpt-4o-mini が使用されます。</span>
                            </p>
                        </div>
                    </>
                )}

                {aiProvider === 'gemini' && (
                    <>
                        <div className={styles.inputGroup}>
                            <label className={styles.label}>
                                Google Gemini API Key
                                <span style={{ display: 'block', fontSize: '0.8em', fontWeight: 'normal', color: '#888' }}>Google Gemini APIキー</span>
                            </label>
                            <input
                                type="password"
                                className={styles.input}
                                value={geminiKey}
                                onChange={(e) => setGeminiKey(e.target.value)}
                                placeholder="AIza..."
                            />
                            <p className={styles.description}>
                                Create an ID at <a href="https://aistudio.google.com/app/api-keys" target="_blank" style={{ color: 'var(--primary)' }}>aistudio.google.com</a><br />
                                <span style={{ fontSize: '0.9em', color: '#999' }}>上記サイトでAPIキーを作成してください。</span>
                            </p>
                        </div>
                        <div className={styles.inputGroup}>
                            <label className={styles.label}>
                                Gemini Model Name
                                <span style={{ display: 'block', fontSize: '0.8em', fontWeight: 'normal', color: '#888' }}>モデル名 (任意)</span>
                            </label>
                            <input
                                type="text"
                                className={styles.input}
                                value={geminiModel}
                                onChange={(e) => setGeminiModel(e.target.value)}
                                placeholder="gemini-2.5-flash"
                            />
                            <p className={styles.description}>
                                Optional. Default: gemini-2.5-flash. See <a href="https://ai.google.dev/models/gemini" target="_blank" style={{ color: 'var(--primary)' }}>Gemini Models</a>.<br />
                                <span style={{ fontSize: '0.9em', color: '#999' }}>指定がない場合は gemini-2.5-flash が使用されます。</span>
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
                        <span style={{ display: 'block', fontSize: '0.8em', fontWeight: 'normal', color: '#888' }}>音声認識の言語</span>
                    </label>
                    <select
                        className={styles.input}
                        value={voiceLang}
                        onChange={(e) => setVoiceLang(e.target.value)}
                        style={{ appearance: 'auto', cursor: 'pointer' }}
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
                        <span style={{ fontSize: '0.9em', color: '#999' }}>音声入力で使用する言語を選択してください。</span>
                    </p>
                </div>
            </div>

            <div className={styles.section}>
                <h2 className={styles.sectionTitle}>
                    Personal Preferences
                    <span style={{ display: 'block', fontSize: '0.6em', fontWeight: 'normal', color: '#888', marginTop: '4px' }}>個人の好み・設定 (Personal Preferences)</span>
                </h2>
                <div className={styles.inputGroup} style={{ position: 'relative' }}>
                    <label className={styles.label}>
                        Universal Style Instructions
                        <span style={{ display: 'block', fontSize: '0.8em', fontWeight: 'normal', color: '#888' }}>共通スタイル指示 (毎回AIへの指示に追加されます)</span>
                        <button
                            onClick={() => setShowPrefHistory(!showPrefHistory)}
                            style={{
                                position: 'absolute',
                                right: 0,
                                top: 0,
                                background: 'transparent',
                                border: '1px solid var(--primary)',
                                color: 'var(--primary)',
                                borderRadius: '4px',
                                fontSize: '0.7em',
                                padding: '2px 8px',
                                cursor: 'pointer'
                            }}
                        >
                            History (履歴)
                        </button>
                    </label>

                    {showPrefHistory && prefHistory.length > 0 && (
                        <div style={{
                            position: 'absolute',
                            top: '50px',
                            right: 0,
                            left: 0,
                            background: '#282828',
                            zIndex: 100,
                            border: '1px solid #444',
                            borderRadius: '4px',
                            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                            maxHeight: '200px',
                            overflowY: 'auto'
                        }}>
                            {prefHistory.map((h, i) => (
                                <div
                                    key={i}
                                    onClick={() => {
                                        setPersonalPref(h);
                                        setShowPrefHistory(false);
                                    }}
                                    style={{
                                        padding: '8px',
                                        borderBottom: '1px solid #333',
                                        cursor: 'pointer',
                                        fontSize: '0.9rem'
                                    }}
                                    className="history-item"
                                >
                                    {h.slice(0, 60)}...
                                </div>
                            ))}
                        </div>
                    )}

                    <textarea
                        className={styles.input}
                        value={personalPref}
                        onChange={(e) => setPersonalPref(e.target.value)}
                        placeholder="e.g. I generally prefer 90s rock. I love live recordings. / 例: 基本的に90年代ロックが好き。ライブ音源は大好きです。"
                        style={{ height: '80px', resize: 'vertical' }}
                    />
                    <p className={styles.description}>
                        These preferences will be appended to the AI prompt as high-priority instructions for every request.<br />
                        <span style={{ fontSize: '0.9em', color: '#999' }}>ここで設定した内容は、AIへのリクエストの際に「最優先の指示」として常に追加されます。</span>
                    </p>
                </div>
            </div>

            <div className={styles.section}>
                <h2 className={styles.sectionTitle}>
                    Experimental Features
                    <span style={{ display: 'block', fontSize: '0.6em', fontWeight: 'normal', color: '#888', marginTop: '4px' }}>実験的機能</span>
                </h2>
                <div className={styles.inputGroup}>
                    <label className={styles.label} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                        <input
                            type="checkbox"
                            checked={backgroundKeepAlive}
                            onChange={(e) => setBackgroundKeepAlive(e.target.checked)}
                            style={{ marginRight: '10px', width: '20px', height: '20px', accentColor: 'var(--primary)' }}
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
                        <span style={{ fontSize: '0.9em', color: '#999' }}>
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
                        <span style={{ fontSize: '0.9em', color: '#999' }}>ブラウザに保存された履歴データを管理します。</span>
                    </p>
                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                        <button
                            onClick={() => {
                                if (confirm('Are you sure you want to clear the main chat prompt history?\n(チャット履歴を削除しますか？)')) {
                                    localStorage.removeItem(STORAGE_KEYS.PROMPT_HISTORY);
                                    setStatus('Chat history cleared! (チャット履歴を削除しました)');
                                    setTimeout(() => setStatus(''), 3000);
                                }
                            }}
                            style={{
                                background: '#cf6679',
                                color: 'white',
                                border: 'none',
                                padding: '10px 16px',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                fontSize: '0.9rem',
                                marginTop: '8px'
                            }}
                        >
                            Clear Chat History<br />
                            <span style={{ fontSize: '0.8em' }}>(チャット履歴削除)</span>
                        </button>

                        <button
                            onClick={() => {
                                if (confirm('Are you sure you want to clear your personal preferences history?\n(設定履歴を削除しますか？)')) {
                                    localStorage.removeItem('personal_pref_history');
                                    setPrefHistory([]);
                                    setStatus('References history cleared! (設定履歴を削除しました)');
                                    setTimeout(() => setStatus(''), 3000);
                                }
                            }}
                            style={{
                                background: '#b00020',
                                color: 'white',
                                border: 'none',
                                padding: '10px 16px',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                fontSize: '0.9rem',
                                marginTop: '8px'
                            }}
                        >
                            Clear Preferences History<br />
                            <span style={{ fontSize: '0.8em' }}>(設定履歴削除)</span>
                        </button>
                    </div>
                </div>
            </div>

            <div style={{ minHeight: '1.5em', marginBottom: '8px', textAlign: 'center', fontWeight: 'bold' }}>
                {status && <span style={{ color: 'var(--primary)' }}>{status}</span>}
            </div>

            <button className={styles.saveBtn} onClick={handleSave}>
                Save Configuration <span style={{ fontSize: '0.8em', marginLeft: '4px' }}>(保存)</span>
            </button>

            <div style={{ marginTop: '32px', color: '#444', fontSize: '0.75rem', textAlign: 'center' }}>
                ContextDJ v{process.env.NEXT_PUBLIC_APP_VERSION}
            </div>
        </div >
    );
}
