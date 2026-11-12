import { useRef, useCallback } from 'react';
import { DJCore } from '../lib/dj-core';

interface UseVisionInputProps {
    djCore: DJCore | null;
    onPromptGenerated: (prompt: string) => void;
    setStatus: (status: string) => void;
    setToast: (toast: { msg: string; type: 'info' | 'error' | 'success' } | null) => void;
}

export function useVisionInput({ djCore, onPromptGenerated, setStatus, setToast }: UseVisionInputProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleCameraClick = useCallback(() => {
        fileInputRef.current?.click();
    }, []);

    const handleImageUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (!djCore) {
            e.target.value = '';
            setToast({
                msg: 'Please log in to Spotify and configure AI settings first. (先にSpotifyログインとAI設定を完了してください)',
                type: 'error',
            });
            return;
        }

        // Verify format
        if (!file.type.startsWith('image/')) {
            e.target.value = '';
            setToast({ msg: 'Please select an image file. (画像ファイルを選択してください)', type: 'error' });
            return;
        }

        setStatus('📸 Analyzing image... (画像を解析中...)');
        try {
            const reader = new FileReader();
            reader.onload = async () => {
                const resultStr = typeof reader.result === 'string' ? reader.result : '';
                const base64Data = resultStr.includes(',') ? resultStr.split(',')[1] : '';
                try {
                    if (!base64Data) {
                        throw new Error('Invalid image data (画像データが無効です)');
                    }
                    const generatedPrompt = await djCore.analyzeImage(base64Data, file.type);
                    onPromptGenerated(generatedPrompt);
                    setToast({ msg: 'Visual scene description generated! (画像を解釈しました)', type: 'success' });
                    setStatus('Ready');
                } catch (err: unknown) {
                    console.error("Vision Analysis Error:", err);
                    const message = err instanceof Error ? err.message : String(err);
                    setToast({ msg: `Failed to analyze image: ${message}`, type: 'error' });
                    setStatus('⚠️ Image Analysis Failed');
                } finally {
                    if (fileInputRef.current) fileInputRef.current.value = '';
                }
            };
            reader.onerror = () => {
                console.error('FileReader error:', reader.error);
                setToast({ msg: 'Failed to read image file. (画像の読み込みに失敗しました)', type: 'error' });
                setStatus('Ready');
                if (fileInputRef.current) fileInputRef.current.value = '';
            };
            reader.readAsDataURL(file);
        } catch (err: unknown) {
            console.error(err);
            setToast({ msg: 'Failed to read image file. (画像の読み込みに失敗しました)', type: 'error' });
            setStatus('Ready');
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    }, [djCore, onPromptGenerated, setStatus, setToast]);

    return {
        fileInputRef,
        handleCameraClick,
        handleImageUpload,
    };
}
