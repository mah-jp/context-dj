import { useState, useRef, useCallback, useEffect } from 'react';
import { STORAGE_KEYS, DEFAULTS } from '../lib/constants';
import { ISpeechRecognition, SpeechRecognitionEvent } from '../lib/types';
import { getStorageItem } from '../lib/storage';

interface UseVoiceInputProps {
    onResult: (text: string) => void;
    onError?: (msg: string) => void;
}

export function classifySpeechRecognitionError(errorCode?: string): string | null {
    if (!errorCode || errorCode === 'no-speech' || errorCode === 'aborted') {
        return null;
    }
    if (errorCode === 'not-allowed' || errorCode === 'service-not-allowed') {
        return 'Microphone access was denied. Please allow microphone permission in your browser settings. (マイクへのアクセスが拒否されました。ブラウザの権限設定を確認してください)';
    }
    if (errorCode === 'audio-capture') {
        return 'No microphone was found. Please check your audio input device. (マイクが見つかりません。音声入力デバイスを確認してください)';
    }
    if (errorCode === 'network') {
        return 'Network error occurred during voice recognition. (音声認識中にネットワークエラーが発生しました)';
    }
    if (errorCode === 'language-not-supported') {
        return 'Selected voice input language is not supported by this browser. (選択された音声認識言語はこのブラウザでサポートされていません)';
    }
    return `Voice recognition error (${errorCode}). (音声認識エラーが発生しました: ${errorCode})`;
}

export function useVoiceInput({ onResult, onError }: UseVoiceInputProps) {
    const [isListening, setIsListening] = useState(false);
    const recognitionRef = useRef<ISpeechRecognition | null>(null);

    useEffect(() => {
        return () => {
            if (recognitionRef.current) {
                try {
                    recognitionRef.current.abort();
                } catch {
                    // Ignore cleanup errors
                }
                recognitionRef.current = null;
            }
        };
    }, []);

    const toggleListening = useCallback(() => {
        if (isListening) {
            if (recognitionRef.current) {
                try {
                    recognitionRef.current.stop();
                } catch {
                    recognitionRef.current.abort();
                }
            }
            setIsListening(false);
            return;
        }

        if (typeof window === 'undefined') return;

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            onError?.('Voice input is not supported in this browser. Try Chrome, Edge, or Safari. (このブラウザは音声入力に対応していません)');
            return;
        }

        const recognition = new SpeechRecognition();
        const savedLang = getStorageItem(STORAGE_KEYS.VOICE_INPUT_LANG, '');
        recognition.lang = savedLang || navigator.language || DEFAULTS.VOICE_LANG;
        recognition.interimResults = true;
        recognition.continuous = false; // Stop after one sentence/pause

        recognition.onstart = () => setIsListening(true);

        recognition.onresult = (event: SpeechRecognitionEvent) => {
            const transcript = Array.from(event.results)
                .map((result) => result[0].transcript)
                .join('');
            onResult(transcript);
        };

        recognition.onerror = (event: Event & { error?: string }) => {
            console.error('[VoiceInput Error]', event.error);
            setIsListening(false);
            const message = classifySpeechRecognitionError(event.error);
            if (message) {
                onError?.(message);
            }
        };

        recognition.onend = () => {
            setIsListening(false);
        };

        recognitionRef.current = recognition;
        try {
            recognition.start();
        } catch (err) {
            console.error('[VoiceInput Start Error]', err);
            setIsListening(false);
            onError?.('Failed to start voice input. Please try again. (音声入力の開始に失敗しました)');
        }
    }, [isListening, onResult, onError]);

    return {
        isListening,
        toggleListening,
    };
}
