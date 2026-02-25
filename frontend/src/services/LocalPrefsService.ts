const PREFIX = 'hviewer:';

/**
 * Thin wrapper around localStorage for typed user preferences.
 * All values are JSON-serialised; read errors silently return the default.
 */
export class LocalPrefsService {
	get<T>(key: string, defaultValue: T): T {
		try {
			const raw = localStorage.getItem(PREFIX + key);
			if (raw === null) return defaultValue;
			return JSON.parse(raw) as T;
		} catch {
			return defaultValue;
		}
	}

	set<T>(key: string, value: T): void {
		try {
			localStorage.setItem(PREFIX + key, JSON.stringify(value));
		} catch {
			/* storage full or unavailable – silently ignore */
		}
	}

	remove(key: string): void {
		localStorage.removeItem(PREFIX + key);
	}
}

// Typed key constants – extend here as new prefs are added
export const PREF_KEYS = {
	INFO_VISIBLE: 'player.infoVisible',
} as const;
