'use client';

import { useEffect } from 'react';

export default function ServiceWorkerRegister() {
    useEffect(() => {
        // Check if we are in a browser environment
        if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
            return;
        }

        const userAgent = navigator.userAgent || navigator.vendor || (window as Window & { opera?: string }).opera || '';
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

        // Register Service Worker for normal browsers and standalone WebAPKs
        const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
        const swUrl = `${basePath}/sw.js`;

        let hadActiveController = Boolean(navigator.serviceWorker.controller);
        let isReloading = false;
        let deferredReloadPending = false;
        let activeRegistration: ServiceWorkerRegistration | null = null;
        let lastUpdateCheckAt = 0;

        const isOAuthCallbackInProgress = (): boolean => {
            const params = new URLSearchParams(window.location.search);
            return params.has('code') || params.has('error');
        };

        const isUserEditingInput = (): boolean => {
            const active = document.activeElement;
            if (!active) return false;
            const tag = active.tagName;
            return (
                tag === 'TEXTAREA' ||
                tag === 'INPUT' ||
                (active as HTMLElement).isContentEditable === true
            );
        };

        const performSafeReload = () => {
            if (isReloading) {
                return;
            }
            if (isOAuthCallbackInProgress() || isUserEditingInput()) {
                deferredReloadPending = true;
                return;
            }
            deferredReloadPending = false;
            isReloading = true;
            window.location.reload();
        };

        const handleControllerChange = () => {
            if (!hadActiveController) {
                // First-time SW claim (`clientsClaim: true`) — no stale precached JS to replace yet
                hadActiveController = true;
                return;
            }
            performSafeReload();
        };

        const handleDeferredReloadOpportunity = () => {
            if (deferredReloadPending) {
                performSafeReload();
            }
        };

        const checkSwUpdateOnVisible = () => {
            if (document.visibilityState !== 'visible') {
                return;
            }
            handleDeferredReloadOpportunity();
            if (!activeRegistration) {
                return;
            }
            const now = Date.now();
            if (now - lastUpdateCheckAt < 60_000) {
                return;
            }
            lastUpdateCheckAt = now;
            void activeRegistration.update().catch(() => {
                // Ignore transient offline SW update check errors
            });
        };

        navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
        document.addEventListener('visibilitychange', checkSwUpdateOnVisible);
        document.addEventListener('focusout', handleDeferredReloadOpportunity);

        navigator.serviceWorker
            .register(swUrl)
            .then((registration) => {
                activeRegistration = registration;
                lastUpdateCheckAt = Date.now();
                console.log('Service Worker registered with scope:', registration.scope);
                void registration.update().catch(() => {
                    // Ignore transient offline SW update check errors
                });
            })
            .catch((error) => {
                console.error('Service Worker registration failed:', error);
            });

        return () => {
            navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
            document.removeEventListener('visibilitychange', checkSwUpdateOnVisible);
            document.removeEventListener('focusout', handleDeferredReloadOpportunity);
        };
    }, []);

    return null;
}
