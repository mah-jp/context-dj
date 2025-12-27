import styles from '../app/page.module.css';
import { DJCore, Track } from '../lib/dj-core';
import { Bot, Flame, AlertTriangle } from 'lucide-react';
import Onboarding from './Onboarding';
import { ScheduleItem } from '../lib/ai';

interface QueueListProps {
    needsOnboarding: boolean;
    setupStatus: { hasClientId: boolean; hasAiKey: boolean };
    authorized: boolean;
    onLogin: () => void;
    deviceName: string;
    currentQuery: string | null;
    showLogs: () => void;
    showAiThought: boolean;
    schedule: ScheduleItem[];
    queue: Track[];
    showPopularity: boolean;
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
    showAiThought,
    schedule,
    queue,
    showPopularity,
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
                                <Bot size={16} style={{ marginRight: '6px' }} /> AI Strategy:
                            </span>
                            <div>
                                {/* DJ Thought (Comment) */}
                                {showAiThought && (() => {
                                    const activeItem = schedule.find(item => {
                                        const baseSig = item.queries ? item.queries.join('|') : (item.query || '');
                                        const fullSig = baseSig + (item.priorityTrack ? '|' + item.priorityTrack : '');
                                        return fullSig === currentQuery;
                                    });
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
    );
}
