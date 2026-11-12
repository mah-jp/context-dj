'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import styles from './page.module.css';
import { SpotifyAuth } from '../lib/spotify-auth';
import { Send, History, Loader, Settings, Mic, MicOff, Quote, XCircle, CheckCircle, Info, Camera } from 'lucide-react';
import { usePlayerPlayback, usePlayerQueueSchedule, usePlayerActions } from '../context/PlayerContext';
import PlayerBar from '../components/PlayerBar';
import ProcessLogViewer from '../components/ProcessLogViewer';
import ScheduleSidebar from '../components/ScheduleSidebar';
import QueueList from '../components/QueueList';
import DynamicBackground from '../components/DynamicBackground';
import { STORAGE_KEYS } from '../lib/constants';
import { ScheduleItem } from '../lib/types';
import { isWaitingForScheduleStart } from '../lib/dj-utils';
import { getStorageItem, setStorageItem, getStoredJSON, setStoredJSON } from '../lib/storage';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { useVisionInput } from '../hooks/useVisionInput';
import { useIsHydrated } from '../hooks/useIsHydrated';
import { useMinuteClock } from '../hooks/useMinuteClock';

export default function Home() {
  const isHydrated = useIsHydrated();
  const {
    status,
    currentTrack,
    currentQuery,
    deviceName,
    error,
  } = usePlayerPlayback();

  const {
    schedule,
    setSchedule,
    queue,
    handleRemoveScheduleItem,
  } = usePlayerQueueSchedule();
  const minuteClock = useMinuteClock(schedule.length > 0);

  const {
    djCore,
    authorized,
    setStatus,
    needsOnboarding,
    setupStatus,
    clearError,
    startBackgroundKeepAlive,
    syncUIState,
    handlePlayQueueIndex,
  } = usePlayerActions();

  const [inputText, setInputText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputBarRef = useRef<HTMLDivElement>(null);
  const isSubmittingRef = useRef(false);

  const [showHistory, setShowHistory] = useState(false);
  const [showNotesState, setShowNotes] = useState(() => getStorageItem(STORAGE_KEYS.SHOW_NOTES) === 'true');
  const showNotes = isHydrated ? showNotesState : false;
  const [showLogs, setShowLogs] = useState(false);
  const [toast, setToast] = useState<{ msg: string, type: 'info' | 'error' | 'success' } | null>(null);

  const [historyState, setHistory] = useState<string[]>(() => getStoredJSON<string[]>(STORAGE_KEYS.PROMPT_HISTORY, []));
  const history = isHydrated ? historyState : [];
  const [historyIndex, setHistoryIndex] = useState(-1);

  const activeToast = toast || (error ? { msg: error, type: 'error' as const } : null);

  // Derived state for AI/DJ active operations
  const isBusy = status.includes('thinking') ||
    status.includes('Analyzing') ||
    status.includes('Filtering') ||
    status.includes('Curating') ||
    status.includes('Searching') ||
    status.includes('Finishing preload') ||
    status.includes('Starting');

  // Custom Hooks
  const { isListening, toggleListening } = useVoiceInput({
    onResult: setInputText,
    onError: (msg) => setToast({ msg, type: 'error' }),
  });

  const { fileInputRef, handleCameraClick, handleImageUpload } = useVisionInput({
    djCore,
    onPromptGenerated: setInputText,
    setStatus,
    setToast,
  });

  // Auto-dismiss local toast (longer duration for error messages)
  useEffect(() => {
    if (!toast) return;
    const duration = toast.type === 'error' ? 6000 : 4000;
    const timer = setTimeout(() => {
      setToast(null);
    }, duration);
    return () => clearTimeout(timer);
  }, [toast]);

  // Auto-dismiss global error
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => {
      clearError();
    }, 6000);
    return () => clearTimeout(timer);
  }, [error, clearError]);

  // Dismiss history dropdown on outside click or Escape
  useEffect(() => {
    if (!showHistory) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (inputBarRef.current && !inputBarRef.current.contains(e.target as Node)) {
        setShowHistory(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowHistory(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    window.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      window.addEventListener('keydown', handleEscape);
    };
  }, [showHistory]);

  // Sync prompt history & showNotes across browser tabs
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const handleStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === STORAGE_KEYS.SHOW_NOTES) {
        setShowNotes(getStorageItem(STORAGE_KEYS.SHOW_NOTES) === 'true');
      }
      if (e.key === null || e.key === STORAGE_KEYS.PROMPT_HISTORY) {
        setHistory(getStoredJSON<string[]>(STORAGE_KEYS.PROMPT_HISTORY, []));
        setHistoryIndex(-1);
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  // Autosize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [inputText]);

  const handleLogin = () => {
    const clientId = getStorageItem(STORAGE_KEYS.SPOTIFY_CLIENT_ID, '').trim();
    if (clientId) {
      void SpotifyAuth.login(clientId);
    } else {
      setToast({
        msg: 'Please set Spotify Client ID in Settings first. (設定画面でSpotify Client IDを設定してください)',
        type: 'error',
      });
    }
  };

  const handleHistorySelect = (text: string) => {
    setInputText(text);
    setShowHistory(false);
  };

  const handleSend = async () => {
    if (!inputText.trim() || !djCore || isBusy || isSubmittingRef.current) return;
    isSubmittingRef.current = true;

    // Activate background mode (keep alive)
    startBackgroundKeepAlive();

    // Save to history
    const newHistory = [inputText, ...history.filter(h => h !== inputText)].slice(0, 50);
    setHistory(newHistory);
    setStoredJSON(STORAGE_KEYS.PROMPT_HISTORY, newHistory);
    setHistoryIndex(-1);

    setStatus('🤖 AI is thinking... (AIが考え中...)');
    try {
      const prevSchedule = djCore.getSchedule();
      const prevCurrentQuery = djCore.getDJStatus().currentQuery;
      const wasSessionActive = djCore.isSessionPlaybackActive();
      const personalPref = getStorageItem(STORAGE_KEYS.PERSONAL_PREFERENCE, '');
      const schedule = await djCore.createSchedule(inputText, personalPref);

      if (!schedule || schedule.length === 0) {
        setToast({ msg: "AI processed the request but returned no schedule. Try a different prompt.\n(AIがスケジュールを作成できませんでした。別の表現で試してください)", type: 'error' });
        setStatus('⚠️ No schedule created. (作成失敗)');
      } else {
        setInputText('');
        setSchedule(schedule);
        const preserveCurrentPlayback = djCore.shouldPreservePlaybackAfterScheduleChange(
          prevSchedule,
          prevCurrentQuery,
          wasSessionActive
        );
        if (!preserveCurrentPlayback) {
          setStatus('🔎 Curating & preparing tracks... (楽曲を選曲・準備中...)');
        }

        // Trigger immediate check & play (or preserve active playback if only future slots changed)
        await djCore.processDJLoop(false, !preserveCurrentPlayback);
        const latestStatus = djCore.getStateSnapshot().status;
        if (latestStatus.startsWith('⏰')) {
          setStatus(latestStatus);
          setToast({
            msg: `Scheduled to start at ${schedule[0].start}! Standing by. (${schedule[0].start}開始でスケジュールを予約しました)`,
            type: 'info',
          });
        } else if (latestStatus.startsWith('⚠️')) {
          setStatus(latestStatus);
        } else {
          setStatus('Ready');
          setToast({ msg: `Schedule created with ${schedule.length} blocks! (スケジュールを作成しました)`, type: 'success' });
        }

        await syncUIState({ forceAll: true });
      }

    } catch (e: unknown) {
      console.error(e);
      const errorMsg = e instanceof Error ? e.message : "Failed to contact AI (AIとの通信に失敗しました)";
      setStatus(`⚠️ ${errorMsg}`);
      const hasJapanese = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(errorMsg);
      setToast({
        msg: hasJapanese ? errorMsg : `Error: ${errorMsg} (エラーが発生しました)`,
        type: 'error',
      });
    } finally {
      isSubmittingRef.current = false;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing) return;
      if (!e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    } else if (e.key === 'ArrowUp') {
      if ((!inputText || historyIndex >= 0) && history.length > 0) {
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

  const handleRecallItem = (item: ScheduleItem) => {
    // Priority: queries (specific) > query (backup) > userRequest (broad)
    let text = '';
    if (item.queries && item.queries.length > 0) {
      text = item.queries.join(', ');
    } else if (item.query) {
      text = item.query;
    } else {
      text = item.userRequest || '';
    }

    if (!text) return;

    setInputText(text);

    // Focus and scroll to input
    if (textareaRef.current) {
      textareaRef.current.focus();
      // Smooth scroll if needed (though usually it's in view)
      textareaRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    setToast({ msg: 'Context recalled! You can edit or press Send. (文脈を読み込みました)', type: 'info' });
  };

  return (
    <main className={styles.main}>
      {/* Use the smallest image (last in array) for the blur to massively save CPU/GPU */}
      <DynamicBackground imageUrl={currentTrack?.album?.images?.[currentTrack.album.images.length - 1]?.url} />
      {/* 1. Header & Search Bar */}
      <header className={styles.headerContainer}>
        <div className={styles.titleWrapper}>
          <h1 className={styles.title}>
            <a
              href="https://github.com/mah-jp/context-dj"
              target="_blank"
              rel="noopener noreferrer"
              className={styles.titleLink}
              title="View ContextDJ on GitHub"
            >
              ContextDJ
            </a>
          </h1>
          <span className={styles.versionText} style={{ color: '#666', fontWeight: 400 }}>v{process.env.NEXT_PUBLIC_APP_VERSION}</span>
        </div>

        {/* Input Wrapper for columnar layout of Input + Status */}
        <div className={styles.inputColumnWrapper}>

          {/* Input Bar */}
          <div ref={inputBarRef} className={styles.inputBar} style={{ width: '100%', position: 'relative' }}>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleImageUpload}
              accept="image/jpeg,image/png,image/webp,image/gif"
              capture="environment"
              style={{ display: 'none' }}
            />
            
            <button
              className={styles.iconBtn}
              onClick={handleCameraClick}
              disabled={!authorized || isBusy}
              title="Camera/Vision Input"
              aria-label="Camera or Image Input"
              style={{ color: 'var(--primary)' }}
            >
              <Camera size={20} />
            </button>

            {/* Voice Input Button (Moved Left) */}
            <button
              onClick={toggleListening}
              disabled={!authorized || (isBusy && !isListening)}
              className={`${styles.iconBtn} ${styles.voiceBtn}`}
              title={isListening ? "Stop Listening" : "Voice Input"}
              aria-label={isListening ? "Stop Voice Input" : "Start Voice Input"}
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
              onChange={(e) => {
                setInputText(e.target.value);
                setHistoryIndex(-1);
              }}
              onKeyDown={handleKeyDown}
              onFocus={() => setShowHistory(false)} // Auto hide when typing
              disabled={!authorized || isListening}
              rows={1}
            />

            <button
              className={styles.iconBtn}
              onClick={() => setShowHistory(!showHistory)}
              disabled={!authorized || history.length === 0}
              title="History"
              aria-label="Prompt History"
              style={{ color: showHistory ? '#ffec3d' : 'var(--primary)' }}
            >
              <History size={20} />
            </button>

            <button
              className={styles.sendBtn}
              onClick={handleSend}
              title="Send Request"
              aria-label="Send Request"
              disabled={!authorized || isBusy || !inputText.trim()}
              style={{ color: 'var(--primary)' }}
            >
              {isBusy ? (
                <Loader size={20} className={styles.spin} />
              ) : (
                <Send size={20} />
              )}
            </button>

            {showHistory && history.length > 0 && (
              <div className={styles.historyDropdown}>
                {history.map((item, i) => (
                  <div
                    key={`${item}-${i}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleHistorySelect(item)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleHistorySelect(item);
                      }
                    }}
                    className={styles.historyItem}
                  >
                    {item}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Status Display - Below Input Bar */}
          {status && status !== 'Ready' && (
            <div className={styles.statusText}>
              {status}
            </div>
          )}
        </div>

        <div className={styles.headerRight}>
          <button
            className={styles.iconBtn}
            onClick={() => {
              const next = !showNotes;
              setShowNotes(next);
              setStorageItem(STORAGE_KEYS.SHOW_NOTES, String(next));
            }}
            style={{ color: showNotes ? '#ffec3d' : 'var(--primary)' }}
            title={showNotes ? "Hide DJ Notes / 選曲理由を隠す" : "Show DJ Notes / 選曲理由を表示"}
          >
            <Quote size={20} fill={showNotes ? "#ffec3d" : "none"} />
          </button>
          <Link href="/settings" className={styles.settingsLink} aria-label="Settings">
            <Settings size={20} />
          </Link>
        </div>
      </header>

      {/* 2. Main Content Grid */}
      <div className={styles.contentGrid}>
        {/* Left Sidebar: Schedule */}
        <ScheduleSidebar
          schedule={schedule}
          currentQuery={currentQuery}
          now={minuteClock}
          onRemoveItem={handleRemoveScheduleItem}
          onRecallItem={handleRecallItem}
        />

        {/* Main Area: Queue & Strategy */}
        <QueueList
          needsOnboarding={needsOnboarding}
          setupStatus={setupStatus}
          authorized={authorized}
          onLogin={handleLogin}
          deviceName={deviceName}
          currentQuery={currentQuery}
          standbyStartTime={isWaitingForScheduleStart(schedule, minuteClock) ? schedule[0]?.start ?? null : null}
          showLogs={() => setShowLogs(true)}
          queue={queue}
          showNotes={showNotes}
          onSelectTrack={handlePlayQueueIndex}
        />
      </div>

      {/* Log Viewer Modal */}
      {showLogs && (
        <ProcessLogViewer onClose={() => setShowLogs(false)} />
      )}

      {/* Toast Notification */}
      {activeToast && (
        <div
          className={styles.toast}
          role="status"
          title="Click to dismiss"
          onClick={() => {
            setToast(null);
            clearError();
          }}
          style={{ borderLeft: `4px solid ${activeToast.type === 'error' ? '#ef4444' : activeToast.type === 'success' ? 'var(--primary)' : '#3b82f6'}` }}
        >
          {activeToast.type === 'error' && <XCircle size={20} color="#ef4444" style={{ flexShrink: 0 }} />}
          {activeToast.type === 'success' && <CheckCircle size={20} color="var(--primary)" style={{ flexShrink: 0 }} />}
          {activeToast.type === 'info' && <Info size={20} color="#3b82f6" style={{ flexShrink: 0 }} />}
          <span>{activeToast.msg}</span>
        </div>
      )}

      {/* 3. Bottom Player Bar */}
      <PlayerBar
        onLogin={handleLogin}
      />
    </main>
  );
}
