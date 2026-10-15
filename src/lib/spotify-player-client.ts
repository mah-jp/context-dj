import SpotifyWebApi from 'spotify-web-api-js';

/**
 * Handles low-level Spotify Connect REST API interactions (device discovery,
 * playback transfer, shuffle/repeat control, and 204-safe transport commands).
 */
export class SpotifyPlayerClient {
    private spotify: SpotifyWebApi.SpotifyWebApiJs;
    private activeDeviceId: string | null = null;

    constructor(spotify: SpotifyWebApi.SpotifyWebApiJs) {
        this.spotify = spotify;
    }

    getActiveDeviceId(): string | null {
        return this.activeDeviceId;
    }

    async getDevices(): Promise<SpotifyApi.UserDevice[]> {
        try {
            const response = await this.spotify.getMyDevices();
            return response.devices;
        } catch (e) {
            console.warn("Failed to fetch devices:", e);
            return [];
        }
    }

    async setActiveDevice(deviceId: string) {
        this.activeDeviceId = deviceId;
        console.log(`📱 Active device set to: ${deviceId}`);

        const token = this.spotify.getAccessToken();
        if (!token) return;

        try {
            const res = await fetch('https://api.spotify.com/v1/me/player', {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ device_ids: [deviceId] })
            });

            if (!res.ok && res.status !== 204) {
                console.warn(`Transfer playback failed: ${res.status}`);
            } else {
                console.log(`📱 Playback transferred to ${deviceId}`);
            }
        } catch (e) {
            console.error("Failed to transfer playback:", e);
        }
    }

    async resolveTargetDevice(): Promise<string> {
        let deviceId: string | null = this.activeDeviceId;

        for (let attempt = 0; attempt < 3; attempt++) {
            if (deviceId) break;

            const devices = await this.spotify.getMyDevices();
            console.log(`📱 Devices found (attempt ${attempt + 1}):`, devices.devices.map(d => `${d.name} (${d.type}, ${d.is_active ? 'Active' : 'Inactive'})`));

            const activeDevice = devices.devices.find(d => d.is_active);
            deviceId = activeDevice?.id || devices.devices[0]?.id || null;

            if (deviceId) {
                this.activeDeviceId = deviceId;
                break;
            }

            await new Promise(r => setTimeout(r, 1000));
        }

        if (!deviceId) {
            throw new Error("No active device found after retries. Please open Spotify. (再生デバイスが見つかりません。スマホまたはPCでSpotifyを開いてください)");
        }

        return deviceId;
    }

    async startPlaybackOnDevice(deviceId: string, uris: string[]) {
        const token = this.spotify.getAccessToken();
        if (!token) throw new Error("No access token available");

        // Disable shuffle before playing to ensure priority track and story order are respected
        try {
            await fetch(`https://api.spotify.com/v1/me/player/shuffle?state=false&device_id=${deviceId}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            console.log('🔀 Shuffle disabled');
        } catch (e) {
            console.warn('Disable shuffle failed:', e);
        }

        const playUrl = `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`;
        const playBody = JSON.stringify({ uris });

        const res = await fetch(playUrl, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: playBody
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => 'No error details');
            console.error(`Spotify Play API Error: ${res.status} ${res.statusText}`, errText);
            throw new Error(`Spotify Play Failed: ${res.statusText}`);
        }
        console.log('▶️ Playback started successfully (Fetch)');

        // Ensure repeat is off after a short delay to let playback context establish
        setTimeout(async () => {
            const repeatUrl = `https://api.spotify.com/v1/me/player/repeat?state=off&device_id=${deviceId}`;
            try {
                await fetch(repeatUrl, {
                    method: 'PUT',
                    headers: { 'Authorization': `Bearer ${token}` }
                });
            } catch (e) {
                console.warn('Set repeat mode failed (non-critical):', e);
            }
        }, 500);
    }

    async safeControlRequest(endpoint: string, method: 'POST' | 'PUT', body?: unknown) {
        const token = this.spotify.getAccessToken();
        if (!token) return;
        try {
            const res = await fetch(`https://api.spotify.com/v1/me/player/${endpoint}`, {
                method,
                headers: { 'Authorization': `Bearer ${token}` },
                ...(body ? { body: JSON.stringify(body), headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } } : {})
            });
            if (!res.ok && res.status !== 204) {
                console.warn(`Control request ${endpoint} failed: ${res.status}`);
            }
        } catch (e) {
            console.error(`Control request ${endpoint} error:`, e);
        }
    }

    async addToQueue(uri: string) {
        return this.safeControlRequest(`queue?uri=${encodeURIComponent(uri)}`, 'POST');
    }

    async next() { return this.safeControlRequest('next', 'POST'); }
    async previous() { return this.safeControlRequest('previous', 'POST'); }
    async pause() { return this.safeControlRequest('pause', 'PUT'); }
    async resume() { return this.safeControlRequest('play', 'PUT'); }
}
