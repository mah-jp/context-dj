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
        if (!file || !djCore) return;

        // Verify format
        if (!file.type.startsWith('image/')) {
            setToast({ msg: 'Please select an image file. (画像ファイルを選択してください)', type: 'error' });
            return;
        }

        setStatus('📸 Analyzing image... (画像を解析中...)');
        try {
            const reader = new FileReader();
            reader.onload = async () => {
                const base64Data = (reader.result as string).split(',')[1];
                try {
                    const generatedPrompt = await djCore.analyzeImage(base64Data, file.type);
                    onPromptGenerated(generatedPrompt);
                    setToast({ msg: 'Visual scene description generated! (画像を解釈しました)', type: 'success' });
                    setStatus('Ready');
                } catch (err: any) {
                    console.error("Vision Analysis Error:", err);
                    setToast({ msg: `Failed to analyze image: ${err.message || err}`, type: 'error' });
                    setStatus('⚠️ Image Analysis Failed');
                } finally {
                    if (fileInputRef.current) fileInputRef.current.value = '';
                }
            };
            reader.readAsDataURL(file);
        } catch (err: any) {
            console.error(err);
            setToast({ msg: 'Failed to read image file.', type: 'error' });
            setStatus('Ready');
        }
    }, [djCore, onPromptGenerated, setStatus, setToast]);

    return {
        fileInputRef,
        handleCameraClick,
        handleImageUpload,
    };
}
