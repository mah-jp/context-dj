'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import styles from './page.module.css';
import { SpotifyAuth } from '../lib/spotify-auth';
import { DJCore } from '../lib/dj-core'; // Track is inferred usually
import { Send, History, Loader, Clock, Flame, Bot, AlertTriangle, Trash2, Settings, XCircle, CheckCircle, Info, Mic, MicOff, Github } from 'lucide-react';
import { usePlayer } from '../context/PlayerContext';
import Onboarding from '../components/Onboarding';
import PlayerBar from '../components/PlayerBar';
import ProcessLogViewer from '../components/ProcessLogViewer';
import { STORAGE_KEYS } from '../lib/constants';

export default function Home() {
  const {
    djCore,
    authorized,
    status,
    setStatus,
    schedule,
    setSchedule,
    currentQuery,
    queue,
    handleRemoveScheduleItem,
    needsOnboarding,
    deviceName,
    logs,
    error,
    clearError,
    startBackgroundKeepAlive,
  } = usePlayer();

  const [inputText, setInputText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [setupStatus, setSetupStatus] = useState({ hasClientId: false, hasAiKey: false });

  const [showHistory, setShowHistory] = useState(false);
  const [showPopularity, setShowPopularity] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [toast, setToast] = useState<{ msg: string, type: 'info' | 'error' | 'success' } | null>(null);

  const [history, setHistory] = useState<string[]>([]); // Prompt history
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null); // SpeechRecognition instance

  // Auto-dismiss toast
  // Auto-dismiss toast
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // Sync Global Error to Toast
  useEffect(() => {
    if (error) {
      setToast({ msg: `System Message: ${error}`, type: 'error' });
    }
  }, [error]);

  // Autosize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [inputText]);

  useEffect(() => {
    // Check local storage for setup completeness
    if (typeof window !== 'undefined') {
      const clientId = localStorage.getItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID);
      const provider = localStorage.getItem(STORAGE_KEYS.SELECTED_AI_PROVIDER) || 'openai';
      let hasKey = false;
      if (provider === 'gemini') {
        hasKey = !!localStorage.getItem(STORAGE_KEYS.GEMINI_API_KEY);
      } else {
        hasKey = !!localStorage.getItem(STORAGE_KEYS.OPENAI_API_KEY);
      }
      setSetupStatus({ hasClientId: !!clientId, hasAiKey: hasKey });
    }
  }, [needsOnboarding]);

  const handleLogin = () => {
    const clientId = localStorage.getItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID);
    if (clientId) {
      SpotifyAuth.login(clientId);
    } else {
      alert("Please set Spotify Client ID in settings.\n(設定画面でSpotify Client IDを設定してください)");
    }
  };

  // Load history on mount
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.PROMPT_HISTORY);
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to parse history", e);
      }
    }
  }, []);

  const handleHistorySelect = (text: string) => {
    setInputText(text);
    setShowHistory(false);
  };

  const handleSend = async () => {
    if (!inputText.trim() || !djCore) return;

    // Activate background mode (keep alive)
    startBackgroundKeepAlive();

    // Save to history
    const newHistory = [inputText, ...history.filter(h => h !== inputText)].slice(0, 50);
    setHistory(newHistory);
    localStorage.setItem(STORAGE_KEYS.PROMPT_HISTORY, JSON.stringify(newHistory));
    setHistoryIndex(-1);

    setStatus('🤖 AI is thinking... (AIが考え中...)');
    try {
      const personalPref = localStorage.getItem(STORAGE_KEYS.PERSONAL_PREFERENCE) || '';
      const schedule = await djCore.createSchedule(inputText, personalPref);

      if (!schedule || schedule.length === 0) {
        setToast({ msg: "AI processed the request but returned no schedule. Try a different prompt.\n(AIがスケジュールを作成できませんでした。別の表現で試してください)", type: 'error' });
        setStatus('⚠️ No schedule created. (作成失敗)');
      } else {
        setSchedule(schedule);
        localStorage.setItem(STORAGE_KEYS.DJ_SCHEDULE, JSON.stringify(schedule));
        // Clear status to avoid persistent message, rely on Toast for success
        setStatus('Ready');
        setToast({ msg: `Schedule created with ${schedule.length} blocks! (スケジュールを作成しました)`, type: 'success' });

        // Trigger immediate check
        await djCore.processDJLoop();
      }

    } catch (e: any) {
      console.error(e);
      // Clear status to avoid persistent message, rely on Toast for error
      setStatus('Ready');
      setToast({ msg: `Error: ${e.message || "Failed to contact AI"} (エラーが発生しました)`, type: 'error' });
    }
    setInputText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing) return;
      if (!e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    } else if (e.key === 'ArrowUp') {
      if (!inputText && history.length > 0) {
        e.preventDefault();
        const nextIndex = Math.min(historyIndex + 1, history.length - 1);
        setHistoryIndex(nextIndex);
        setInputText(history[nextIndex]);
      }
    } else if (e.key === 'ArrowDown') {
      if (historyIndex >= 0) { // Only if traversing history
        e.preventDefault();
        if (historyIndex > 0) {
          const nextIndex = historyIndex - 1;
          setHistoryIndex(nextIndex);
          setInputText(history[nextIndex]);
        } else {
          setHistoryIndex(-1);
          setInputText('');
        }
      }
    }
  };

  // Voice Input Handler
  const toggleListening = () => {
    if (isListening) {
      if (recognitionRef.current) recognitionRef.current.stop();
      setIsListening(false);
      return;
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setToast({ msg: 'Voice input not supported in this browser.', type: 'error' });
      return;
    }

    const recognition = new SpeechRecognition();
    // Default to 'ja-JP' but verify settings
    const savedLang = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.VOICE_INPUT_LANG) : null;
    recognition.lang = savedLang || navigator.language || 'ja-JP';
    recognition.interimResults = true;
    recognition.continuous = false; // Stop after one sentence/pause

    recognition.onstart = () => setIsListening(true);

    recognition.onresult = (event: any) => {
      const transcript = Array.from(event.results)
        .map((result: any) => result[0].transcript)
        .join('');
      setInputText(transcript);
    };

    recognition.onerror = (event: any) => {
      console.error(event.error);
      setIsListening(false);
      // Ignore no-speech error
      if (event.error !== 'no-speech') {
        setToast({ msg: 'Voice recognition error.', type: 'error' });
      }
    };

    recognition.onend = () => {
      setIsListening(false);
      // Optionally auto-send? No, let user confirm.
    };

    recognitionRef.current = recognition;
    recognition.start();
  };

  return (
    <div className={styles.main}>
      {/* 1. Header & Search Bar */}
      <header className={styles.headerContainer}>
        <div className={styles.titleWrapper}>
          <h1 className={styles.title}>ContextDJ</h1>
          <span className={styles.versionText} style={{ color: '#666', fontWeight: 400 }}>v{process.env.NEXT_PUBLIC_APP_VERSION}</span>
        </div>

        {/* Input Wrapper for columnar layout of Input + Status */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', maxWidth: '480px', position: 'relative' }}>

          {/* Input Bar */}
          <div className={styles.inputBar} style={{ width: '100%', position: 'relative' }}>
            {/* Voice Input Button (Moved Left) */}
            <button
              onClick={toggleListening}
              className={`${styles.iconBtn} ${styles.voiceBtn}`}
              title={isListening ? "Stop Listening" : "Voice Input"}
              style={{
                color: isListening ? '#ef4444' : 'var(--primary)'
              }}
            >
              {isListening ? <MicOff size={20} className={isListening ? styles.pulse : ''} /> : <Mic size={20} />}
            </button>

            <textarea
              ref={textareaRef}
              placeholder={isListening ? "Listening..." : "Hey DJ, play some music for..."}
              className={styles.input}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => setShowHistory(false)} // Auto hide when typing
              disabled={!authorized || isListening}
              rows={1}
            />

            <button
              className={styles.iconBtn}
              onClick={() => setShowHistory(!showHistory)}
              title="History"
            >
              <History size={18} />
            </button>

            <button className={styles.sendBtn} onClick={handleSend} title="Send Request" disabled={!authorized || status.includes('thinking')}>
              {status.includes('thinking') ? (
                <Loader size={18} className={styles.spin} />
              ) : (
                <Send size={18} />
              )}
            </button>

            {showHistory && history.length > 0 && (
              <div style={{
                position: 'absolute',
                top: '120%',
                left: 0,
                right: 0,
                background: '#282828',
                borderRadius: '8px',
                padding: '8px 0',
                maxHeight: '300px',
                overflowY: 'auto',
                boxShadow: '0 16px 24px rgba(0,0,0,0.5)',
                zIndex: 2000
              }}>
                {history.map((item, i) => (
                  <div
                    key={i}
                    onClick={() => handleHistorySelect(item)}
                    style={{
                      padding: '8px 16px',
                      cursor: 'pointer',
                      fontSize: '0.9rem',
                      color: '#eee',
                      borderBottom: '1px solid #333'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = '#333'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    {item}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Status Display - Below Input Bar */}
          {status && status !== 'Ready' && (
            <div style={{
              marginTop: '4px',
              fontSize: '0.75rem',
              color: 'var(--accent)',
              whiteSpace: 'nowrap',
              pointerEvents: 'none'
            }}>
              {status}
            </div>
          )}
        </div>

        <div className={styles.headerRight}>
          <button
            className={styles.iconBtn}
            onClick={() => setShowPopularity(!showPopularity)}
            style={{ color: showPopularity ? '#ffec3d' : undefined }}
            title={showPopularity ? "Hide Popularity" : "Show Popularity"}
          >
            <Flame size={20} fill={showPopularity ? "#ffec3d" : "none"} />
          </button>
          <Link href="/settings" className={styles.settingsLink} aria-label="Settings">
            <Settings size={20} />
          </Link>
        </div>
      </header>

      {/* 2. Main Content Grid */}
      <div className={styles.contentGrid}>
        {/* Left Sidebar: Schedule */}
        <div className={styles.sidebar}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px', color: 'var(--primary)', fontWeight: 600 }}>
            <Clock size={20} />
            <span>My Schedule</span>
          </div>
          {schedule.length > 0 ? schedule.map((item, i) => {
            const isActive = currentQuery && (item.queries ? item.queries.join('|') === currentQuery : item.query === currentQuery);
            return (
              <div
                key={i}
                className={styles.scheduleItem}
                style={{
                  position: 'relative',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  borderLeft: isActive ? '3px solid var(--primary)' : '3px solid transparent',
                  background: isActive ? 'rgba(3, 218, 198, 0.05)' : undefined
                }}
              >
                <div style={{ flex: 1, marginRight: '8px' }}>
                  <div className={styles.scheduleTime} style={{ color: isActive ? 'var(--primary)' : undefined }}>{item.start} - {item.end}</div>
                  <div className={styles.scheduleQuery}>
                    {item.queries ? item.queries.join(', ') : item.query}
                  </div>
                </div>
                <button
                  onClick={() => handleRemoveScheduleItem(i)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#666',
                    cursor: 'pointer',
                    padding: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'color 0.2s'
                  }}
                  title="Remove schedule item"
                  onMouseEnter={(e) => e.currentTarget.style.color = '#cf6679'}
                  onMouseLeave={(e) => e.currentTarget.style.color = '#666'}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          }) : (
            <div style={{ color: '#555', fontSize: '0.9rem', padding: '1rem' }}>No active schedule.</div>
          )}
        </div>

        {/* Main Area: Queue & Strategy */}
        <div className={styles.queueArea}>
          {needsOnboarding ? (
            <Onboarding
              setupStatus={setupStatus}
              authorized={authorized}
              onLogin={handleLogin}
            />
          ) : (
            <>
              {/* Connection Warning */}
              {authorized && !deviceName && (
                <div style={{
                  marginBottom: '1rem', padding: '12px', background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '8px', color: '#fca5a5',
                  display: 'flex', alignItems: 'center', gap: '10px', fontSize: '0.9rem'
                }}>
                  <AlertTriangle size={20} />
                  <span><b>No Active Device:</b> Open Spotify on your phone or computer to start playback.<br />(再生デバイスが見つかりません。スマホまたはPCでSpotifyを開いてください。)</span>
                </div>
              )}

              {/* AI Status */}
              {currentQuery && (
                <div
                  className={styles.aiStatus}
                  onClick={() => setShowLogs(true)}
                  style={{ cursor: 'pointer' }}
                  title="Click to view process log"
                >
                  <span style={{ color: 'var(--primary)', fontSize: '0.85rem', fontWeight: 'bold', display: 'flex', alignItems: 'center' }}>
                    <Bot size={16} style={{ marginRight: '6px' }} /> AI Strategy:
                  </span>
                  <div>
                    {/* DJ Thought (Comment) */}
                    {(() => {
                      const activeItem = schedule.find(item => item.queries ? item.queries.join('|') === currentQuery : item.query === currentQuery);
                      if (activeItem?.thought) {
                        return (
                          <div style={{
                            marginBottom: '8px',
                            padding: '8px 12px',
                            background: 'rgba(255, 255, 255, 0.08)',
                            borderRadius: '6px',
                            fontSize: '0.9rem',
                            fontStyle: 'italic',
                            color: '#e0e0e0',
                            borderLeft: '3px solid var(--primary)'
                          }}>
                            "{activeItem.thought}"
                          </div>
                        );
                      }
                      return null;
                    })()}

                    {/* Tags */}
                    {currentQuery.split('|').map((tag, i) => (
                      <span key={i} className={styles.aiTag}>{tag.trim()}</span>
                    ))}
                  </div>
                </div>
              )}

              <h2 className={styles.queueHeader}>Up Next</h2>

              <div className={styles.queueList}>
                {queue.length > 0 ? queue.map((track, i) => (
                  <div
                    key={i}
                    className={styles.queueItem}
                    onClick={() => {
                      const tracksToPlay = queue.slice(i);
                      djCore?.playTracks(tracksToPlay);
                    }}
                  >
                    <div className={styles.queueIndex}>{i + 1}</div>
                    <img
                      src={track.album?.images?.[0]?.url || ''}
                      className={styles.queueImg}
                      alt="art"
                    />
                    <div className={styles.queueMeta}>
                      <div className={styles.queueTitle}>
                        {track.name}
                        {track.contextName && <span style={{ fontSize: '0.7em', color: 'var(--primary)', marginLeft: '6px', border: '1px solid var(--primary)', padding: '0 4px', borderRadius: '4px' }}>{track.contextName}</span>}
                      </div>
                      <div className={styles.queueArtist}>{track.artists[0]?.name}</div>
                    </div>
                    {showPopularity && (
                      <div className={styles.queuePop} title={`Popularity: ${track.popularity}`} style={{ color: '#ffec3d' }}>
                        <Flame size={12} fill="#ffec3d" />
                        <span>{track.popularity}</span>
                      </div>
                    )}
                  </div>
                )) : (
                  <div style={{ color: '#555', padding: '2rem', textAlign: 'center' }}>Queue is empty.</div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Log Viewer Modal */}
      {showLogs && (
        <ProcessLogViewer logs={logs} onClose={() => setShowLogs(false)} />
      )}

      {/* Toast Notification */}
      {toast && (
        <div className={styles.toast} style={{ borderLeft: `4px solid ${toast.type === 'error' ? '#ef4444' : toast.type === 'success' ? 'var(--primary)' : '#3b82f6'}` }}>
          {toast.type === 'error' && <XCircle size={20} color="#ef4444" />}
          {toast.type === 'success' && <CheckCircle size={20} color="var(--primary)" />}
          {toast.type === 'info' && <Info size={20} color="#3b82f6" />}
          <span>{toast.msg}</span>
        </div>
      )}

      {/* 3. Bottom Player Bar */}
      <PlayerBar
        showPopularity={showPopularity}
        onLogin={handleLogin}
      />
    </div>
  );
}
