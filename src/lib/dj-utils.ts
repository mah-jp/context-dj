import { Track } from './types';

/**
 * Normalizes track titles by stripping version strings, remaster tags, and parentheses.
 */
export function normalizeTrackName(name: string): string {
    // Remove text within parentheses (half-width and full-width)
    let clean = name.replace(/[(\[（［].*?[)\]）］]/g, '');
    // Remove common metadata patterns after hyphen or space
    clean = clean.replace(/\s[-/〜~]\s.*$/g, '');
    // Remove remastered/version strings
    clean = clean.replace(/(remaster|version|live|edit|radio|mix).*$/i, '');

    return clean.trim().toLowerCase();
}

/**
 * Generates a unique deduplication key for a track based on normalized title and main artist.
 */
export function generateTrackKey(track: Track | SpotifyApi.TrackObjectFull): string {
    const cleanName = normalizeTrackName(track.name);
    const artist = track.artists[0]?.name.toLowerCase().trim() || '';
    return `${cleanName}|${artist}`;
}
