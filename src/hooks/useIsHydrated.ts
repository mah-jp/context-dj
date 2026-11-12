import { useSyncExternalStore } from 'react';

const subscribeNoop = () => () => {};
const getClientHydrated = () => true;
const getServerHydrated = () => false;

/**
 * Returns `false` during SSR and initial client hydration, then synchronously switches to `true`
 * on the client without triggering React 19 hydration mismatches or `set-state-in-effect` warnings.
 */
export function useIsHydrated(): boolean {
    return useSyncExternalStore(subscribeNoop, getClientHydrated, getServerHydrated);
}
