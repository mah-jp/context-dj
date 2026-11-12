import { useRef, useCallback } from 'react';
import { DJCore } from '../lib/dj-core';

export const MAX_VISION_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB raw input ceiling
const DOWNSCALE_THRESHOLD_BYTES = 1.5 * 1024 * 1024; // Downscale > 1.5 MB photos via Canvas
const MAX_VISION_DIMENSION_PX = 1536;

const SUPPORTED_VISION_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
]);

export interface VisionFileValidationResult {
    ok: boolean;
    normalizedMimeType?: string;
    errorMessage?: string;
}

/**
 * Validates image MIME type and byte size before encoding for OpenAI / Gemini Vision APIs.
 */
export function validateVisionImageFile(file: {
    type: string;
    size: number;
    name?: string;
}): VisionFileValidationResult {
    const rawMime = (file.type || '').trim().toLowerCase();
    const extMatch = (file.name || '').trim().toLowerCase().match(/\.([a-z0-9]+)$/);
    const ext = extMatch ? extMatch[1] : '';

    if (file.size <= 0) {
        return {
            ok: false,
            errorMessage: 'Selected image file is empty. (選択された画像ファイルが空です)',
        };
    }

    if (file.size > MAX_VISION_IMAGE_BYTES) {
        const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
        return {
            ok: false,
            errorMessage: `Image file is too large (${sizeMb}MB). Please choose an image under 20MB. (画像サイズが大きすぎます[${sizeMb}MB]。20MB以下の画像を選択してください)`,
        };
    }

    let normalizedMime = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime;
    if (!normalizedMime && ext) {
        if (ext === 'jpg' || ext === 'jpeg') normalizedMime = 'image/jpeg';
        else if (ext === 'png') normalizedMime = 'image/png';
        else if (ext === 'webp') normalizedMime = 'image/webp';
        else if (ext === 'gif') normalizedMime = 'image/gif';
    }

    if (!normalizedMime.startsWith('image/') && !['heic', 'heif', 'svg', 'bmp', 'tiff', 'tif', 'avif'].includes(ext)) {
        return {
            ok: false,
            errorMessage: 'Please select an image file. (画像ファイルを選択してください)',
        };
    }

    if (!SUPPORTED_VISION_MIME_TYPES.has(normalizedMime)) {
        const formatLabel = normalizedMime || (ext ? `.${ext}` : 'unknown');
        return {
            ok: false,
            errorMessage: `Unsupported image format (${formatLabel}). Please use JPEG, PNG, WebP, or GIF. (未対応の画像形式です[${formatLabel}]。JPEG・PNG・WebP・GIF画像を選択してください)`,
        };
    }

    return {
        ok: true,
        normalizedMimeType: normalizedMime,
    };
}

function readFileAsBase64(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const resultStr = typeof reader.result === 'string' ? reader.result : '';
            const base64Data = resultStr.includes(',') ? resultStr.split(',')[1] : '';
            if (!base64Data) {
                reject(new Error('Invalid image data (画像データが無効です)'));
                return;
            }
            resolve(base64Data);
        };
        reader.onerror = () => {
            reject(new Error('Failed to read image file. (画像の読み込みに失敗しました)'));
        };
        reader.readAsDataURL(file);
    });
}

async function downscaleLargeImageIfNeeded(
    file: File,
    normalizedMimeType: string
): Promise<{ base64Data: string; mimeType: string }> {
    if (
        file.size <= DOWNSCALE_THRESHOLD_BYTES ||
        normalizedMimeType === 'image/gif' ||
        typeof document === 'undefined' ||
        typeof Image === 'undefined' ||
        typeof URL === 'undefined' ||
        typeof URL.createObjectURL !== 'function'
    ) {
        const base64Data = await readFileAsBase64(file);
        return { base64Data, mimeType: normalizedMimeType };
    }

    const objectUrl = URL.createObjectURL(file);
    try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('Image decode failed'));
            el.src = objectUrl;
        });

        const { naturalWidth: w, naturalHeight: h } = img;
        if (!w || !h) {
            const base64Data = await readFileAsBase64(file);
            return { base64Data, mimeType: normalizedMimeType };
        }

        const scale = Math.min(1, MAX_VISION_DIMENSION_PX / Math.max(w, h));
        const targetW = Math.max(1, Math.round(w * scale));
        const targetH = Math.max(1, Math.round(h * scale));

        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            const base64Data = await readFileAsBase64(file);
            return { base64Data, mimeType: normalizedMimeType };
        }

        ctx.drawImage(img, 0, 0, targetW, targetH);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        const base64Data = dataUrl.includes(',') ? dataUrl.split(',')[1] : '';
        if (!base64Data) {
            const rawBase64 = await readFileAsBase64(file);
            return { base64Data: rawBase64, mimeType: normalizedMimeType };
        }
        return { base64Data, mimeType: 'image/jpeg' };
    } catch {
        const base64Data = await readFileAsBase64(file);
        return { base64Data, mimeType: normalizedMimeType };
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

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

        const validation = validateVisionImageFile(file);
        if (!validation.ok || !validation.normalizedMimeType) {
            e.target.value = '';
            setToast({
                msg: validation.errorMessage || 'Please select a valid image file. (有効な画像ファイルを選択してください)',
                type: 'error',
            });
            return;
        }

        setStatus('📸 Analyzing image... (画像を解析中...)');
        try {
            const { base64Data, mimeType } = await downscaleLargeImageIfNeeded(file, validation.normalizedMimeType);
            const generatedPrompt = await djCore.analyzeImage(base64Data, mimeType);
            onPromptGenerated(generatedPrompt);
            setToast({ msg: 'Visual scene description generated! (画像を解釈しました)', type: 'success' });
            setStatus('Ready');
        } catch (err: unknown) {
            console.error('Vision Analysis Error:', err);
            const message = err instanceof Error ? err.message : String(err);
            const hasJapanese = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(message);
            setToast({
                msg: hasJapanese ? message : `Failed to analyze image: ${message} (画像の解析に失敗しました)`,
                type: 'error',
            });
            setStatus('⚠️ Image Analysis Failed');
        } finally {
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    }, [djCore, onPromptGenerated, setStatus, setToast]);

    return {
        fileInputRef,
        handleCameraClick,
        handleImageUpload,
    };
}
