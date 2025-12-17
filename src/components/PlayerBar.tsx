import { useState } from 'react';
import { usePlayer } from '../context/PlayerContext';
import styles from '../app/page.module.css';
import { Play, Pause, SkipBack, SkipForward, MonitorSpeaker, Flame, Share2 } from 'lucide-react';

interface PlayerBarProps {
    showPopularity: boolean;
    onLogin: () => void;
}

export default function PlayerBar({ showPopularity, onLogin }: PlayerBarProps) {
    const {
        status,
        authorized,
        isPlaying,
        currentTrack,
        deviceName,
        devices,
        refreshDevices,
        setDevice,
        handlePrev,
        handleNext,
        handleTogglePlay,
        currentQuery
    } = usePlayer();

    // Local UI state
    const [showCover, setShowCover] = useState(false);
    const [showDevices, setShowDevices] = useState(false);

    const handleShare = async () => {
        if (!currentTrack) return;

        const artistName = (currentTrack.artists || []).map(a => a.name).join(', ') || 'Unknown Artist';

        let rawContext = (currentQuery || 'Freestyle').replace(/\s+/g, ' ').trim();
        // Truncate context to fit within X (Twitter) character limit (approx 140 Japanese chars)
        // Cap context at 80 characters to leave room for track info and URL.
        if (rawContext.length > 80) {
            rawContext = rawContext.substring(0, 80) + '...';
        }
        const contextText = currentQuery ? `"${rawContext}"` : 'Freestyle';

        // Optimize whitespace: replace 2+ spaces with 1, trim
        const shareText = `🎵 ${currentTrack.name} / ${artistName}\n🧠 Context: ${contextText}\n#ContextDJ`
            .replace(/ +/g, ' ')
            .trim();
        const shareUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://contextdj.remoteroom.jp';

        // Check if mobile to decide sharing method
        // On Desktop (macOS/Windows), native share menu is often less useful or hides 'Copy'.
        // We prefer direct X (Twitter) intent on Desktop for better UX.
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

        if (isMobile && navigator.share) {
            try {
                await navigator.share({
                    title: 'ContextDJ',
                    text: shareText,
                    url: shareUrl,
                });
            } catch (err) {
                console.warn('Share failed:', err);
            }
        } else {
            // Desktop or non-supported browsers: Open X (Twitter) Intent directly
            const textParam = encodeURIComponent(`${shareText}\n${shareUrl}`);
            window.open(`https://x.com/intent/post?text=${textParam}`, '_blank');
        }
    };

    return (
        <div className={styles.bottomPlayer}>
            {/* Large Cover Popup */}
            {showCover && currentTrack?.album?.images?.[0]?.url && (
                <div style={{
                    position: 'fixed',
                    bottom: '90px',
                    left: '20px',
                    width: '300px',
                    height: '300px',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                    zIndex: 1000,
                    animation: 'fadeIn 0.2s ease-out'
                }}>
                    <img
                        src={currentTrack.album.images[0].url}
                        alt="Large Cover"
                        style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '8px' }}
                    />
                </div>
            )}

            {/* Left: Now Playing Info */}
            <div className={styles.nowPlaying}>
                {currentTrack ? (
                    <>
                        <div
                            style={{ position: 'relative', cursor: 'zoom-in' }}
                            onMouseEnter={() => setShowCover(true)}
                            onMouseLeave={() => setShowCover(false)}
                        >
                            <img
                                src={currentTrack.album?.images?.[0]?.url || ''}
                                className={styles.nowPlayingImg}
                                alt="Now Playing"
                            />
                        </div>
                        <div className={styles.nowPlayingText}>
                            <div className={styles.nowPlayingTitle}>
                                <a href={currentTrack.external_urls?.spotify} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '4px' }} className={styles.hoverUnderline}>
                                    {currentTrack.name}
                                </a>
                                {isPlaying && (
                                    <div className={styles.equalizer}>
                                        <div className={styles.bar}></div>
                                        <div className={styles.bar}></div>
                                        <div className={styles.bar}></div>
                                    </div>
                                )}
                            </div>
                            <div className={styles.nowPlayingArtist}>
                                <a href={currentTrack.artists?.[0]?.external_urls?.spotify} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }} className={styles.hoverUnderline}>
                                    {(currentTrack.artists || []).map(a => a.name).join(', ')}
                                </a>
                            </div>
                            {currentTrack.contextName && (
                                <div style={{ fontSize: '0.65rem', color: 'var(--primary)', marginTop: '2px', opacity: 0.8 }}>
                                    {currentTrack.contextName}
                                </div>
                            )}
                            {showPopularity && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px', fontSize: '0.7em', color: '#ffec3d' }}>
                                    <Flame size={10} fill="#ffec3d" />
                                    <span>{currentTrack.popularity}</span>
                                </div>
                            )}
                        </div>
                    </>
                ) : (
                    <div style={{ display: 'flex', alignItems: 'center', color: '#555' }}>
                        <div className={styles.nowPlayingImg} />
                        <span>Not Playing</span>
                    </div>
                )}
            </div>

            {/* Center: Controls */}
            <div className={styles.playerControls}>
                <div className={styles.controlButtons}>
                    <button className={styles.controlBtn} onClick={handlePrev} title="Previous" aria-label="Previous Track">
                        <SkipBack size={20} fill="currentColor" />
                    </button>

                    {!authorized && status === 'connect_needed' ? (
                        <button className={styles.controlBtn} onClick={onLogin} aria-label="Login to Spotify" style={{ fontSize: '0.8rem', border: '1px solid #fff', borderRadius: '20px', padding: '4px 12px' }}>
                            Log in to Spotify
                        </button>
                    ) : (
                        <button className={`${styles.controlBtn} ${styles.playPauseBtn}`} onClick={handleTogglePlay} disabled={!authorized} aria-label={isPlaying ? 'Pause' : 'Play'}>
                            {isPlaying ? <Pause size={20} fill="black" /> : <Play size={20} fill="black" style={{ marginLeft: '2px' }} />}
                        </button>
                    )}

                    <button className={styles.controlBtn} onClick={handleNext} title="Next" aria-label="Next Track">
                        <SkipForward size={20} fill="currentColor" />
                    </button>
                </div>
            </div>

            {/* Right: Extra Controls */}
            <div className={styles.extraControls}>
                {/* Share Button */}
                {currentTrack && (
                    <button
                        className={styles.deviceLabel}
                        onClick={handleShare}
                        title="Share Context"
                        aria-label="Share Context"
                        style={{ marginRight: '16px', cursor: 'pointer' }}
                    >
                        <Share2 size={16} />
                        <span>Share</span>
                    </button>
                )}

                <div style={{ position: 'relative' }}>
                    <button
                        className={styles.deviceLabel}
                        onClick={() => {
                            setShowDevices(!showDevices);
                            if (!showDevices) refreshDevices();
                        }}
                        title="Switch Device"
                        aria-label="Switch Device"
                    >
                        <MonitorSpeaker size={16} />
                        <span>{deviceName || "No Device"}</span>
                    </button>

                    {/* Device Dropdown */}
                    {showDevices && (
                        <div style={{
                            position: 'absolute',
                            bottom: '120%',
                            right: 0,
                            background: '#282828',
                            borderRadius: '8px',
                            padding: '8px 0',
                            width: '240px',
                            boxShadow: '0 8px 16px rgba(0,0,0,0.5)',
                            zIndex: 2000,
                            border: '1px solid #333'
                        }}>
                            <div style={{ padding: '8px 16px', fontSize: '0.8rem', color: '#888', borderBottom: '1px solid #333', marginBottom: '4px' }}>
                                Select Device
                            </div>
                            {devices.length > 0 ? devices.map((device: any) => (
                                <div
                                    key={device.id}
                                    onClick={() => {
                                        setDevice(device.id);
                                        setShowDevices(false);
                                    }}
                                    style={{
                                        padding: '8px 16px',
                                        cursor: 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '8px',
                                        color: device.is_active ? 'var(--primary)' : '#eee',
                                        background: device.is_active ? 'rgba(3, 218, 198, 0.1)' : 'transparent'
                                    }}
                                    onMouseEnter={(e) => e.currentTarget.style.background = '#333'}
                                    onMouseLeave={(e) => e.currentTarget.style.background = device.is_active ? 'rgba(3, 218, 198, 0.1)' : 'transparent'}
                                >
                                    <MonitorSpeaker size={14} />
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: '0.9rem' }}>{device.name}</div>
                                        <div style={{ fontSize: '0.7rem', color: '#666' }}>{device.type}</div>
                                    </div>
                                    {device.is_active && <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--primary)' }} />}
                                </div>
                            )) : (
                                <div style={{ padding: '12px', textAlign: 'center', color: '#666', fontSize: '0.9rem' }}>
                                    No devices found.<br />Open Spotify first.
                                    <button
                                        onClick={() => refreshDevices()}
                                        style={{ marginTop: '8px', background: 'transparent', border: '1px solid #666', color: '#888', borderRadius: '4px', padding: '2px 8px', cursor: 'pointer', fontSize: '0.8rem' }}
                                    >
                                        Refresh
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
