import { component, signal } from 'chispa';
import { PlayerView } from './PlayerView';
import { DirTreeView } from './DirTreeView';
import tpl from './MainView.html';

export const MainView = component(() => {
	// ── State ───────────────────────────────────────────────────────────────────────────
	const selectedPath = signal<string | null>(null);

	// ── Read initial query params ───────────────────────────────────────────────────────
	const params = new URLSearchParams(window.location.search);
	const initialFilePath = params.get('file') ?? null;

	// ── Sync selected video with URL ────────────────────────────────────────────────────────
	const setSelectedPath = (p: string | null) => {
		selectedPath.set(p);
		const url = new URL(window.location.href);
		if (p) {
			url.searchParams.set('file', p);
		} else {
			url.searchParams.delete('file');
		}
		window.history.replaceState(null, '', url.toString());
	};

	// Pre-select from ?file= param: path is already the identity, no API call needed
	if (initialFilePath) {
		selectedPath.set(initialFilePath);
	}

	// ── Render ──────────────────────────────────────────────────────────────────────────────
	return tpl.fragment({
		root: {
			classes: {
				'has-selection': () => selectedPath.get() !== null,
			},
		},

		appVersion: {
			inner: 'v' + __APP_MANIFEST__.version,
		},

		// Directory tree
		treeWrap: {
			inner: DirTreeView({
				onSelectVideo: setSelectedPath,
				selectedPath,
				initialFilePath,
			}),
		},

		// Placeholder (hidden when a video is selected)
		placeholder: {
			classes: { hidden: () => selectedPath.get() !== null },
		},

		// Player area
		playerWrap: {
			inner: () => {
				const p = selectedPath.get();
				if (!p) return '';
				return PlayerView({
					videoPath: p,
					onBack: () => setSelectedPath(null),
				});
			},
		},
	});
});

