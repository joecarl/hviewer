import Hls from 'hls.js';
import { component, onUnmount, signal } from 'chispa';
import { services } from '../../services/container/ServiceContainer';
import { VideoApiService, type ProbeStream } from '../../services/VideoApiService';
import tpl from './PlayerView.html';

export interface PlayerProps {
	videoId: string;
	onBack: () => void;
}

export const PlayerView = component<PlayerProps>(({ videoId, onBack }) => {
	const api = services.get(VideoApiService);

	// ── State ────────────────────────────────────────────────────────────────
	const title = signal('Loading…');
	const audioTrackList = signal<{ id: number; name: string }[]>([]);
	const currentAudio = signal(-1);
	const audioLoading = signal(false);
	const subtitleList = signal<{ localIdx: number; name: string }[]>([]);
	const currentSub = signal(-1);

	let hls: Hls | null = null;
	let videoEl: HTMLVideoElement | null = null;

	// ── HLS init ─────────────────────────────────────────────────────────────
	const initHls = (el: HTMLVideoElement) => {
		videoEl = el;
		if (hls) {
			hls.destroy();
			hls = null;
		}

		const masterUrl = api.getMasterPlaylistUrl(videoId);

		if (Hls.isSupported()) {
			hls = new Hls({ enableWorker: true });
			hls.loadSource(masterUrl);
			hls.attachMedia(el);

			// AUDIO_TRACKS_UPDATED fires after EXT-X-MEDIA audio groups are parsed
			// (MANIFEST_PARSED fires too early when audio is in a separate group)
			hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
				const tracks = hls!.audioTracks.map((t, i) => ({
					id: t.id,
					name: t.name || t.lang || `Audio ${i + 1}`,
				}));
				audioTrackList.set(tracks);
				currentAudio.set(hls!.audioTrack);
			});

			hls.on(Hls.Events.MANIFEST_PARSED, () => {
				el.play().catch(() => {
					/* autoplay blocked, fine */
				});
			});

			hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_, data) => {
				currentAudio.set(data.id);
				// AUDIO_TRACK_SWITCHED fires when HLS has loaded the new segments, but the
				// old audio buffer may not have drained yet. The next 'timeupdate' or
				// 'playing' event means the new audio is actually reaching the output.

				setTimeout(() => {
					audioLoading.set(false);
				}, 2500); // fallback in case no events fire
			});

			hls.on(Hls.Events.ERROR, (_, data) => {
				if (data.fatal) {
					console.error('[HLS] Fatal error:', data);
				}
			});
		} else if (el.canPlayType('application/vnd.apple.mpegurl')) {
			// Safari native HLS
			el.src = masterUrl;
			el.play().catch(() => {});
		}
	};

	// ── Audio switching ───────────────────────────────────────────────────────
	const switchAudio = (id: number) => {
		if (hls) hls.audioTrack = id;
		audioLoading.set(true);
	};

	// ── Subtitle switching ────────────────────────────────────────────────────
	const switchSub = (localIdx: number) => {
		if (!videoEl) return;
		// Remove previously injected tracks
		Array.from(videoEl.querySelectorAll('track[data-hv]')).forEach((t) => t.remove());
		currentSub.set(localIdx);
		if (localIdx < 0) return;

		const track = document.createElement('track');
		track.setAttribute('data-hv', '');
		track.kind = 'subtitles';
		track.src = api.getSubtitleUrl(videoId, localIdx);
		track.default = true;
		videoEl.appendChild(track);

		// Give the browser a tick to parse the track before showing
		setTimeout(() => {
			// Match by position: our newly appended track is the last <track> element
			const trackEls = Array.from(videoEl!.querySelectorAll('track'));
			const trackIdx = trackEls.indexOf(track);
			const tl = videoEl!.textTracks;
			for (let i = 0; i < tl.length; i++) {
				tl[i].mode = i === trackIdx ? 'showing' : 'hidden';
			}
		}, 150);
	};

	// ── Load video details ────────────────────────────────────────────────────
	api.getDetails(videoId).then((details) => {
		title.set(details.name);

		const subs = details.streams
			.filter((s): s is ProbeStream & { codec_type: 'subtitle' } => s.codec_type === 'subtitle')
			.map((s, localIdx) => ({
				localIdx,
				name: s.tags?.title ?? s.tags?.language ?? `Track ${localIdx + 1}`,
			}));
		subtitleList.set(subs);
	});

	// ── Cleanup ───────────────────────────────────────────────────────────────
	onUnmount(() => {
		hls?.destroy();
		hls = null;
	});

	// ── Render ────────────────────────────────────────────────────────────────
	return tpl.fragment({
		playerRoot: {},

		backBtn: {
			onclick: onBack,
		},

		playerTitle: {
			inner: () => title.get(),
		},

		videoEl: {
			_ref: (el: HTMLVideoElement) => initHls(el),
		},

		audioSection: {
			classes: { hidden: () => audioTrackList.get().length <= 1 },
		},

		audioLoadingIndicator: {
			inner: () => (audioLoading.get() ? 'switching…' : ''),
		},

		audioButtons: {
			inner: () =>
				audioTrackList.get().map((t) =>
					tpl.audioBtn({
						inner: t.name,
						classes: { 'is-active': () => currentAudio.get() === t.id },
						onclick: () => switchAudio(t.id),
					})
				),
		},

		subtitleSection: {
			classes: { hidden: () => subtitleList.get().length === 0 },
		},

		subtitleButtons: {
			inner: () => [
				tpl.subtitleBtn({
					inner: 'Off',
					classes: { 'is-active': () => currentSub.get() === -1 },
					onclick: () => switchSub(-1),
				}),
				...subtitleList.get().map((s) =>
					tpl.subtitleBtn({
						inner: s.name,
						classes: { 'is-active': () => currentSub.get() === s.localIdx },
						onclick: () => switchSub(s.localIdx),
					})
				),
			],
		},
	});
});
