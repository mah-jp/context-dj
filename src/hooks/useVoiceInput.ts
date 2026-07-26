import { useState, useRef, useCallback } from 'react';
import { STORAGE_KEYS, DEFAULTS } from '../lib/constants';
import { ISpeechRecognition, SpeechRecognitionEvent } from '../lib/types';
import { getStorageItem } from '../lib/storage';

interface UseVoiceInputProps {
    onResult: (text: string) => void;
    onError?: (msg: string) => void;
}

export function useVoiceInput({ onResult, onError }: UseVoiceInputProps) {
    const [isListening, setIsListening] = useState(false);
    const recognitionRef = useRef<ISpeechRecognition | null>(null);

    const toggleListening = useCallback(() => {
        if (isListening) {
            if (recognitionRef.current) recognitionRef.current.stop();
            setIsListening(false);
            return;
        }

        if (typeof window === 'undefined') return;

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            onError?.('Voice input not supported in this browser.');
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
            if (event.error !== 'no-speech') {
                onError?.('Voice recognition error.');
            }
        };

        recognition.onend = () => {
            setIsListening(false);
        };

        recognitionRef.current = recognition;
        recognition.start();
    }, [isListening, onResult, onError]);

    return {
        isListening,
        toggleListening,
    };
}
