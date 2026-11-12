import styles from '../app/page.module.css';
import { Bot, AlertTriangle, Anchor, Clock } from 'lucide-react';
import Onboarding from './Onboarding';
import { Track } from '../lib/types';

interface QueueListProps {
    needsOnboarding: boolean;
    setupStatus: { hasClientId: boolean; hasAiKey: boolean };
    authorized: boolean;
    onLogin: () => void;
    deviceName: string;
    currentQuery: string | null;
    standbyStartTime?: string | null;
    showLogs: () => void;
    queue: Track[];
    showNotes: boolean;
    onSelectTrack: (index: number) => void;
}

export default function QueueList({
    needsOnboarding,
    setupStatus,
    authorized,
    onLogin,
    deviceName,
    currentQuery,
    standbyStartTime,
    showLogs,
    queue,
    showNotes,
    onSelectTrack,
}: QueueListProps) {
    return (
        <div className={styles.queueArea}>
            {needsOnboarding ? (
                <Onboarding
                    setupStatus={setupStatus}
                    authorized={authorized}
                    onLogin={onLogin}
                />
            ) : (
                <>
                    {/* Connection Warning */}
                    {authorized && !deviceName && (
                        <div className={styles.noDeviceBanner}>
                            <AlertTriangle size={20} />
                            <span><b>No Active Device:</b> Open Spotify on your phone or computer to start playback.<br />(再生デバイスが見つかりません。スマホまたはPCでSpotifyを開いてください。)</span>
                        </div>
                    )}

                    {/* AI Status */}
                    {currentQuery && (
                        <div
                            className={styles.aiStatus}
                            role="button"
                            tabIndex={0}
                            aria-label="View DJ Process Log"
                            onClick={showLogs}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    showLogs();
                                }
                            }}
                            style={{ cursor: 'pointer' }}
                            title="Click to view process log"
                        >
                            <span style={{ color: 'var(--primary)', fontSize: '0.85rem', fontWeight: 'bold', display: 'flex', alignItems: 'center' }}>
                                <Bot size={16} style={{ marginRight: '6px' }} /> Search Keywords:
                            </span>
                            <div>
                                {/* Tags */}
                                {currentQuery.split('|').map((tag, i) => (
                                    <span key={`${tag}-${i}`} className={styles.aiTag}>{tag.trim()}</span>
                                ))}
                            </div>
                        </div>
                    )}

                    <h2 className={styles.queueHeader}>Up Next</h2>

                    <div className={styles.queueList}>
                        {queue.length > 0 ? queue.map((track, i) => (
                            <div
                                key={`${track.uri || track.id || 'queue'}-${i}`}
                                className={styles.queueItem}
                                role="button"
                                tabIndex={0}
                                aria-label={`Play ${track.name} by ${track.artists[0]?.name || 'Unknown'}`}
                                onClick={() => onSelectTrack(i)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        onSelectTrack(i);
                                    }
                                }}
                            >
                                <div className={styles.queueIndex}>{i + 1}</div>
                                {track.album?.images?.[0]?.url ? (
                                    <img
                                        src={track.album.images[0].url}
                                        className={styles.queueImg}
                                        alt=""
                                    />
                                ) : (
                                    <div className={styles.queueImg} aria-hidden="true" />
                                )}
                                <div className={styles.queueMeta}>
                                    <div className={styles.queueTitle}>
                                        <span>{track.name}</span>
                                        {track.vibeTag && (
                                            <span
                                                className={styles.vibeBadge}
                                                title={track.selectionReason ? `【選曲理由】${track.selectionReason}` : track.vibeTag}
                                            >
                                                {track.vibeTag}
                                            </span>
                                        )}
                                        {/* Stage badge: visible when showNotes is ON */}
                                        {showNotes && track.stage && (
                                            <span
                                                className={`${styles.stageBadge} ${
                                                    track.stage === 'peak' ? styles.stageBadgePeak :
                                                    track.stage === 'build' ? styles.stageBadgeBuild :
                                                    track.stage === 'outro' ? styles.stageBadgeOutro :
                                                    styles.stageBadgeIntro
                                                }`}
                                                title={`【起承転結: ${
                                                    track.stage === 'intro' ? 'Intro (導入)' :
                                                    track.stage === 'build' ? 'Build (展開)' :
                                                    track.stage === 'peak' ? 'Peak (絶頂)' : 'Outro (余韻)'
                                                }】Energy: ${track.energy ?? 5}/10${track.estimatedBpm ? ` | BPM: ~${track.estimatedBpm}` : ''}`}
                                            >
                                                {track.stage}
                                            </span>
                                        )}
                                        {/* Anchor badge: only visible when showNotes (quote icon) is ON */}
                                        {showNotes && track.contextName?.startsWith('Anchor:') && (
                                            <span className={styles.anchorBadge} title="ムードを決定づけるアンカー曲（象徴曲）">
                                                <Anchor size={10} />
                                                象徴曲
                                            </span>
                                        )}
                                        {/* Other contexts like Playlist: only visible when showNotes is ON */}
                                        {showNotes && track.contextName && !track.contextName.startsWith('Anchor:') && (
                                            <span className={styles.contextBadge} style={{ maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {track.contextName}
                                            </span>
                                        )}
                                    </div>
                                    <div className={styles.queueArtist}>{track.artists[0]?.name}</div>
                                    {showNotes && (track.selectionReason || track.contextName?.startsWith('Anchor:') || track.stage) && (
                                        <div
                                            className={styles.queueReason}
                                            title={track.selectionReason}
                                        >
                                            {track.contextName?.startsWith('Anchor:') && (
                                                <span style={{ color: '#38bdf8', fontWeight: 600, marginRight: '6px' }}>
                                                    [⚓ 象徴曲]
                                                </span>
                                            )}
                                            {track.stage && (
                                                <span className={
                                                    track.stage === 'peak' ? styles.stageTextPeak :
                                                    track.stage === 'build' ? styles.stageTextBuild :
                                                    track.stage === 'outro' ? styles.stageTextOutro :
                                                    styles.stageTextIntro
                                                }>
                                                    [{track.stage.toUpperCase()}{track.energy ? ` ⚡${track.energy}` : ''}]
                                                </span>
                                            )}
                                            {track.selectionReason}
                                        </div>
                                    )}
                                </div>
                            </div>
                        )) : standbyStartTime ? (
                            <div
                                style={{
                                    color: '#cbd5e1',
                                    padding: '1.5rem',
                                    textAlign: 'center',
                                    background: 'rgba(245, 158, 11, 0.06)',
                                    border: '1px solid rgba(245, 158, 11, 0.25)',
                                    borderRadius: '8px',
                                    lineHeight: 1.6,
                                }}
                            >
                                <div style={{ color: '#fbbf24', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                                    <Clock size={16} />
                                    <span>Standing by until {standbyStartTime} ({standbyStartTime} の開始まで待機中)</span>
                                </div>
                                <div style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
                                    Tracks will be curated automatically 1 minute before scheduled start.<br />
                                    (開始1分前に自動で選曲・再生準備を開始します)
                                </div>
                            </div>
                        ) : (
                            <div style={{ color: '#555', padding: '2rem', textAlign: 'center' }}>Queue is empty.</div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
