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

	// ── Load video list ───────────────────────────────────────────────────────
	const load = async () => {
		try {
			loading.set(true);
			errorMsg.set(null);
			const list = await api.getVideos();
			videos.set(list);
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
						onclick: () => selectedId.set(v.id),
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
					onBack: () => selectedId.set(null),
				});
			},
		},
	});
});
