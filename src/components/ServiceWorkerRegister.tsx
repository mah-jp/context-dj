'use client';

import { useEffect } from 'react';

export default function ServiceWorkerRegister() {
    useEffect(() => {
        // Check if we are in a browser environment
        if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
            return;
        }

        const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera || '';
        const blockedApps = [
            'FBAN',      // Facebook App Name
            'FBAV',      // Facebook App Version
            'Instagram',
            'Line',
            'Twitter',
            'TikTok',
            'LinkedIn',
            'Snapchat',
        ];

        // Detect in-app browsers (WebView)
        // These browsers often have issues with Service Workers or Caching on first load
        const isInApp = new RegExp(blockedApps.join('|'), 'i').test(userAgent);

        if (isInApp) {
            console.log('In-app browser detected (Social Media App). Skipping Service Worker registration to prevent white screen issues.');
            return;
        }

        // Register Service Worker for normal browsers
        const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
        const swUrl = `${basePath}/sw.js`;

        navigator.serviceWorker
            .register(swUrl)
            .then((registration) => {
                console.log('Service Worker registered with scope:', registration.scope);
            })
            .catch((error) => {
                console.error('Service Worker registration failed:', error);
            });
    }, []);

    return null;
}
