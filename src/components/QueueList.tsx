import styles from '../app/page.module.css';
import { DJCore } from '../lib/dj-core';
import { Bot, AlertTriangle, Anchor } from 'lucide-react';
import Onboarding from './Onboarding';
import { Track, ScheduleItem } from '../lib/types';

interface QueueListProps {
    needsOnboarding: boolean;
    setupStatus: { hasClientId: boolean; hasAiKey: boolean };
    authorized: boolean;
    onLogin: () => void;
    deviceName: string;
    currentQuery: string | null;
    showLogs: () => void;
    schedule: ScheduleItem[];
    queue: Track[];
    showNotes: boolean;
    djCore: DJCore | null;
}

export default function QueueList({
    needsOnboarding,
    setupStatus,
    authorized,
    onLogin,
    deviceName,
    currentQuery,
    showLogs,
    schedule,
    queue,
    showNotes,
    djCore
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
                            onClick={showLogs}
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
                                key={track.uri || track.id || `queue-${i}`}
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
                                                <span style={{
                                                    color: track.stage === 'peak' ? '#f43f5e' : track.stage === 'build' ? '#fbbf24' : track.stage === 'outro' ? '#a78bfa' : '#34d399',
                                                    fontWeight: 600,
                                                    marginRight: '6px'
                                                }}>
                                                    [{track.stage.toUpperCase()}{track.energy ? ` ⚡${track.energy}` : ''}]
                                                </span>
                                            )}
                                            {track.selectionReason}
                                        </div>
                                    )}
                                </div>
                            </div>
                        )) : (
                            <div style={{ color: '#555', padding: '2rem', textAlign: 'center' }}>Queue is empty.</div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
