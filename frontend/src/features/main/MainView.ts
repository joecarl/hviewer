import { component, signal } from 'chispa';
import { services } from '../../services/container/ServiceContainer';
import { VideoApiService, type VideoInfo } from '../../services/VideoApiService';
import { PlayerView } from './PlayerView';
import { fbytes } from '../../utils/formats';
import tpl from './MainView.html';

export const MainView = component(() => {
	const api = services.get(VideoApiService);

	// ── State ────────────────────────────────────────────────────────────────
	const videos = signal<VideoInfo[]>([]);
	const selectedId = signal<string | null>(null);
	const loading = signal(true);
	const errorMsg = signal<string | null>(null);

	// ── Sync selected video with URL query param ──────────────────────────────
	const setSelectedId = (id: string | null) => {
		selectedId.set(id);
		const url = new URL(window.location.href);
		if (id) {
			url.searchParams.set('videoId', id);
		} else {
			url.searchParams.delete('videoId');
			url.searchParams.delete('file');
		}
		window.history.replaceState(null, '', url.toString());
	};

	// ── Load video list ───────────────────────────────────────────────────────
	const load = async () => {
		try {
			loading.set(true);
			errorMsg.set(null);
			const list = await api.getVideos();
			videos.set(list);

			// ── Open file from query params ───────────────────────────────────
			const params = new URLSearchParams(window.location.search);
			const filePath = params.get('file');
			const videoIdParam = params.get('videoId');

			if (filePath) {
				try {
					const video = await api.getVideoByPath(filePath);
					setSelectedId(video.id);
				} catch {
					errorMsg.set(`Cannot open file: ${filePath}`);
				}
			} else if (videoIdParam && list.some((v) => v.id === videoIdParam)) {
				setSelectedId(videoIdParam);
			}
		} catch (e) {
			errorMsg.set((e as Error).message);
		} finally {
			loading.set(false);
		}
	};
	load();

	// ── Render ────────────────────────────────────────────────────────────────
	return tpl.fragment({
		root: {
			classes: {
				'has-selection': () => selectedId.get() !== null,
			},
		},

		appVersion: {
			inner: 'v' + __APP_MANIFEST__.version,
		},

		// Video count badge
		videoCount: {
			inner: () => {
				if (loading.get()) return '';
				const n = videos.get().length;
				return n === 0 ? '' : String(n);
			},
		},

		// List of videos
		videoList: {
			inner: () => {
				if (loading.get()) {
					return tpl.listMessage({ inner: 'Loading videos…' });
				}
				const err = errorMsg.get();
				if (err) {
					return tpl.listMessage({ addClass: 'hv-error', inner: `Error: ${err}` });
				}
				const list = videos.get();
				if (list.length === 0) {
					return tpl.listMessage({ innerHTML: 'No videos found.<br> Set the <strong>VIDEO_PATH</strong> env var to your video folder.' });
				}
				return list.map((v) =>
					tpl.videoItem({
						onclick: () => setSelectedId(v.id),
						classes: { 'is-selected': () => selectedId.get() === v.id },
						nodes: {
							videoItemExt: { inner: v.ext.replace('.', '').toUpperCase() },
							videoItemName: { inner: v.name },
							videoItemSize: { inner: fbytes(v.size) },
						},
					})
				);
			},
		},

		// Placeholder (hidden when a video is selected)
		placeholder: {
			classes: { hidden: () => selectedId.get() !== null },
		},

		// Player area
		playerWrap: {
			inner: () => {
				const id = selectedId.get();
				if (!id) return '';
				return PlayerView({
					videoId: id,
					onBack: () => setSelectedId(null),
				});
			},
		},
	});
});
