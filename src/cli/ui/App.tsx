import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { DJRunner, DJRunnerState } from '../dj-runner';
import { RequestHistory } from '../history';

interface AppProps {
    runner: DJRunner;
    initialPrompt?: string;
}

function formatDuration(ms: number): string {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function renderProgressBar(currentMs: number, totalMs: number, width = 28): string {
    if (!totalMs || totalMs <= 0) return '─'.repeat(width);
    const ratio = Math.min(1, Math.max(0, currentMs / totalMs));
    const filled = Math.round(ratio * width);
    const empty = Math.max(0, width - filled);
    return '█'.repeat(filled) + '░'.repeat(empty);
}

export const App: React.FC<AppProps> = ({ runner, initialPrompt }) => {
    const { exit } = useApp();
    const [state, setState] = useState<DJRunnerState>(runner.getState());
    const [queryInput, setQueryInput] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
    const historyRef = useRef<RequestHistory>(RequestHistory.load());

    // Subscribe to DJRunner state updates
    useEffect(() => {
        const unsubscribe = runner.subscribe((newState) => {
            setState(newState);
        });

        runner.startAutoLoop();

        // Process initial prompt if provided via command-line arguments
        if (initialPrompt && initialPrompt.trim().length > 0) {
            historyRef.current.add(initialPrompt.trim());
            setIsSubmitting(true);
            runner.sendRequest(initialPrompt)
                .catch((err) => {
                    setFeedbackMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
                })
                .finally(() => {
                    setIsSubmitting(false);
                });
        }

        return () => {
            unsubscribe();
            runner.stopAutoLoop();
        };
    }, [runner, initialPrompt]);

    // Handle global keyboard shortcuts & history navigation
    useInput((input, key) => {
        if (key.ctrl && input === 'c') {
            runner.stopAutoLoop();
            exit();
            return;
        }

        // Up / Down arrow navigation for request history
        if (key.upArrow) {
            const prev = historyRef.current.getPrevious(queryInput);
            if (prev !== null) {
                setQueryInput(prev);
            }
            return;
        }

        if (key.downArrow) {
            const next = historyRef.current.getNext();
            if (next !== null) {
                setQueryInput(next);
            }
            return;
        }

        // When not submitting, support quick action keys if input is empty
        if (!isSubmitting && queryInput.length === 0) {
            if (input === ' ') {
                // Space: Play/Pause toggle
                runner.togglePlay().catch(() => {});
                return;
            }
            if (input === 'n' || input === 'N') {
                // Next track
                runner.next().catch(() => {});
                return;
            }
            if (input === 'p' || input === 'P') {
                // Previous track
                runner.previous().catch(() => {});
                return;
            }
            if (input === 'q' || input === 'Q') {
                runner.stopAutoLoop();
                exit();
                return;
            }
        }
    });

    const handleSubmit = async (value: string) => {
        const trimmed = value.trim();
        if (!trimmed || isSubmitting) return;

        // Record to history
        historyRef.current.add(trimmed);

        setIsSubmitting(true);
        setQueryInput('');
        setFeedbackMessage('Processing request...');

        try {
            await runner.sendRequest(trimmed);
            setFeedbackMessage('Schedule updated & playing!');
        } catch (e) {
            setFeedbackMessage(`Failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setIsSubmitting(false);
        }
    };

    const currentTrack = state.currentTrack;
    const isPlaying = state.playbackState?.is_playing || false;
    const progressMs = state.playbackState?.progress_ms || 0;
    const durationMs = currentTrack?.duration_ms || 0;
    const activeDeviceName = state.activeDevice?.name || state.playbackState?.device?.name || 'No active device';

    return (
        <Box flexDirection="column" paddingX={1} paddingY={0}>
            {/* Header */}
            <Box borderStyle="single" borderColor="cyan" justifyContent="space-between" paddingX={1}>
                <Text bold color="cyan">
                    🎧 ContextDJ <Text dimColor>| AI Music Curator (CUI)</Text>
                </Text>
                <Text>
                    Device: <Text color={state.activeDevice ? 'green' : 'yellow'}>{activeDeviceName}</Text>
                    {' '}| Status: <Text color="magenta">{state.status}</Text>
                </Text>
            </Box>

            {/* Now Playing Panel */}
            <Box borderStyle="round" borderColor={isPlaying ? 'green' : 'gray'} flexDirection="column" paddingX={1} marginY={0}>
                <Box justifyContent="space-between">
                    <Text bold color="green">
                        {isPlaying ? '▶ NOW PLAYING' : '⏸ PAUSED'}
                    </Text>
                    <Text dimColor>
                        {formatDuration(progressMs)} / {formatDuration(durationMs)}
                    </Text>
                </Box>

                {currentTrack ? (
                    <Box flexDirection="column" marginY={0}>
                        <Text bold color="white">
                            {currentTrack.name}
                            <Text color="dim"> — </Text>
                            <Text color="yellow">{currentTrack.artists.map(a => a.name).join(', ')}</Text>
                        </Text>
                        <Text dimColor>
                            Album: {currentTrack.album?.name || 'Unknown'}
                        </Text>
                        <Box marginY={0}>
                            <Text color="cyan">{renderProgressBar(progressMs, durationMs)}</Text>
                        </Box>
                        {/* Curated AI Metadata */}
                        {(currentTrack.vibeTag || currentTrack.stage || currentTrack.selectionReason) && (
                            <Box marginTop={0}>
                                <Text color="blue">
                                    [Vibe: {currentTrack.vibeTag || 'N/A'}]
                                    {currentTrack.energy !== undefined && ` [Energy: ${currentTrack.energy}%]`}
                                    {currentTrack.stage && ` [Stage: ${currentTrack.stage}]`}
                                </Text>
                            </Box>
                        )}
                        {currentTrack.selectionReason && (
                            <Text color="dim">
                                Reason: {currentTrack.selectionReason}
                            </Text>
                        )}
                    </Box>
                ) : (
                    <Text dimColor>No track currently playing. Send a music request below!</Text>
                )}
            </Box>

            {/* DJ's Thought Panel */}
            {state.currentThought && (
                <Box borderStyle="single" borderColor="magenta" flexDirection="column" paddingX={1} marginY={0}>
                    <Text bold color="magenta">📻 DJ's Thought (選曲の意図)</Text>
                    <Text italic color="white">
                        {state.currentThought}
                    </Text>
                </Box>
            )}

            {/* Schedule & Queue */}
            {state.schedule.length > 0 && (
                <Box borderStyle="single" borderColor="blue" flexDirection="column" paddingX={1} marginY={0}>
                    <Text bold color="blue">📋 Active Schedule ({state.schedule.length} blocks)</Text>
                    {state.schedule.slice(0, 3).map((item, idx) => (
                        <Box key={idx} justifyContent="space-between">
                            <Text color="white">
                                <Text bold color="yellow">[{item.start} - {item.end}]</Text> {item.queries?.join(', ') || item.userRequest || 'Curated Block'}
                            </Text>
                            {item.anchorTracks && item.anchorTracks.length > 0 && (
                                <Text dimColor>Anchors: {item.anchorTracks.slice(0, 2).join(' / ')}</Text>
                            )}
                        </Box>
                    ))}
                </Box>
            )}

            {/* Recent Process Logs (Last 2 items) */}
            {state.logs.length > 0 && (
                <Box flexDirection="column" marginY={0} paddingX={1}>
                    <Text dimColor>Log: {state.logs.slice(-2).join(' | ')}</Text>
                </Box>
            )}

            {/* Feedback message */}
            {feedbackMessage && (
                <Box paddingX={1}>
                    <Text color="yellow">ℹ {feedbackMessage}</Text>
                </Box>
            )}

            {/* Interactive Request Input */}
            <Box borderStyle="double" borderColor="yellow" flexDirection="column" paddingX={1} marginY={0}>
                <Box>
                    <Text bold color="yellow">💬 Request: </Text>
                    {isSubmitting ? (
                        <Text color="cyan">AI is curating your music schedule...</Text>
                    ) : (
                        <TextInput
                            value={queryInput}
                            onChange={setQueryInput}
                            onSubmit={handleSubmit}
                            placeholder="Type request (e.g. 'Chill beats for late night coding') and press Enter"
                        />
                    )}
                </Box>
                <Box marginTop={0} justifyContent="space-between">
                    <Text dimColor>
                        Controls: [↑/↓] History | (when input empty) [Space] Play/Pause | [n] Next | [p] Prev | [q] Quit
                    </Text>
                </Box>
            </Box>
        </Box>
    );
};
