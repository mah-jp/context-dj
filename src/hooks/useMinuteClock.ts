import { useCallback, useMemo, useSyncExternalStore } from 'react';

const getMinuteBucketClient = (): number => Math.floor(Date.now() / 60_000) * 60_000;
const getMinuteBucketServer = (): number | null => null;
const subscribeNoop = () => () => {};

/**
 * Subscribes to minute-aligned wall-clock boundaries via `useSyncExternalStore` when `enabled` is true.
 * Returns `undefined` during SSR/hydration and a stable `Date` per minute on the client,
 * keeping schedule standby / active / past indicators accurate on `:00` transitions even when idle.
 */
export function useMinuteClock(enabled: boolean = true): Date | undefined {
    const subscribe = useCallback(
        (onStoreChange: () => void) => {
            if (!enabled || typeof window === 'undefined') {
                return () => {};
            }
            let timerId: ReturnType<typeof setTimeout> | null = null;
            const scheduleNextTick = () => {
                const delayMs = 60_000 - (Date.now() % 60_000) + 50;
                timerId = setTimeout(() => {
                    onStoreChange();
                    scheduleNextTick();
                }, delayMs);
            };
            scheduleNextTick();
            return () => {
                if (timerId !== null) {
                    clearTimeout(timerId);
                }
            };
        },
        [enabled]
    );

    const minuteEpochMs = useSyncExternalStore(
        enabled ? subscribe : subscribeNoop,
        getMinuteBucketClient,
        getMinuteBucketServer
    );

    return useMemo(
        () => (minuteEpochMs !== null ? new Date(minuteEpochMs) : undefined),
        [minuteEpochMs]
    );
}
