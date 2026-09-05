import Hls from 'hls.js';
import { component, onUnmount, signal } from 'chispa';
import { services } from '../../services/container/ServiceContainer';
import { VideoApiService, type ProbeStream } from '../../services/VideoApiService';
import { LocalPrefsService, PREF_KEYS } from '../../services/LocalPrefsService';
import { fbytes, fDuration } from '../../utils/formats';
import tpl from './PlayerView.html';

function parseFps(rate?: string): string {
	if (!rate) return '';
	const [num, den] = rate.split('/').map(Number);
	if (!num || !den) return '';
	const fps = num / den;
	const rounded = Math.round(fps * 100) / 100;
	return `${rounded % 1 === 0 ? rounded : rounded.toFixed(2)}fps`;
}

export interface PlayerProps {
	videoPath: string;
	onBack: () => void;
}

export const PlayerView = component<PlayerProps>(({ videoPath, onBack }) => {
	const api = services.get(VideoApiService);
	const prefs = services.get(LocalPrefsService);

	// ── State ────────────────────────────────────────────────────────────────
	const title = signal('Loading…');
	const audioTrackList = signal<{ id: number; name: string }[]>([]);
	const currentAudio = signal(-1);
	const audioLoading = signal(false);
	const subtitleList = signal<{ localIdx: number; name: string }[]>([]);
	const currentSub = signal(-1);

	// ── Info bar state ────────────────────────────────────────────────────────
	const infoVisible = signal(prefs.get(PREF_KEYS.INFO_VISIBLE, false));
	const infoVideoText = signal('');
	const infoAudioText = signal('');
	const infoDurationText = signal('');

	// ── Playback status ───────────────────────────────────────────────────────
	const statusText = signal('');

	let hls: Hls | null = null;
	let videoEl: HTMLVideoElement | null = null;
	// Set once we've asked the server to re-encode after the browser rejected the
	// original stream — guards against bouncing between the two forever.
	let forcedTranscode = false;
	let mediaErrorRecoveries = 0;

	// ── HLS init ─────────────────────────────────────────────────────────────
	const initHls = (el: HTMLVideoElement, forceTranscode = false) => {
		videoEl = el;
		if (hls) {
			hls.destroy();
			hls = null;
		}
		mediaErrorRecoveries = 0;

		const masterUrl = api.getMasterPlaylistUrl(videoPath, forceTranscode);

		if (Hls.isSupported()) {
			hls = new Hls({
				enableWorker: true,
				// Our server may take up to 60 s to produce a segment (FFmpeg restart + encode).
				// hls.js default is 20 s — raise it so it doesn't give up before we're done.
				fragLoadingTimeOut: 60_000,
				manifestLoadingTimeOut: 30_000,
				// Allow extra retries — transient 500s during a seek-restart are normal.
				fragLoadingMaxRetry: 6,
				fragLoadingRetryDelay: 500,
				// Keep the look-ahead buffer short so hls.js doesn't flood the server
				// with segment requests for positions we haven't transcoded yet.
				maxMaxBufferLength: 30,
			});
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

			// Media is flowing again — clear any warning we put up. initHls can run twice
			// (transcode fallback), so bind once per element instead of stacking listeners.
			if (!el.dataset['hvStatusBound']) {
				el.dataset['hvStatusBound'] = '1';
				el.addEventListener('playing', () => statusText.set(''));
			}

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
				console.warn('[HLS] Error:', data.type, data.details, data.fatal);

				// The browser refused the codec we sent it. Our capability probe said it
				// could decode this, so it was wrong (or the decoder is unavailable right
				// now) — ask the server for an H.264 re-encode instead. Checked before the
				// fatal filter because BUFFER_ADD_CODEC_ERROR is reported as non-fatal.
				const codecRejected =
					data.details === Hls.ErrorDetails.BUFFER_ADD_CODEC_ERROR ||
					data.details === Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR ||
					data.details === Hls.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR;

				if (codecRejected && !forcedTranscode) {
					console.warn('[HLS] Codec rejected by this browser — falling back to a server-side H.264 transcode');
					forcedTranscode = true;
					statusText.set('This browser cannot decode the original codec — re-encoding on the server, this may take a moment…');
					initHls(el, true);
					return;
				}

				if (!data.fatal) return;

				// Without recovery, a fatal error leaves hls.js dead and the video element
				// frozen with whatever was buffered (appears as "seekbar shrinks to ~20 s").
				if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
					// recoverMediaError() re-arms the pipeline, but when the media is simply
					// undecodable it fails again immediately — cap the retries so we surface
					// the problem instead of spinning forever on a black frame.
					if (++mediaErrorRecoveries > 3) {
						console.error('[HLS] Media error recovery exhausted — giving up');
						statusText.set('Playback failed: this browser could not decode the stream.');
						hls!.destroy();
						hls = null;
						return;
					}
					console.warn('[HLS] Recovering from fatal media error…');
					hls!.recoverMediaError();
				} else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
					// Fatal network error (e.g. segment 500 after all retries).
					// Reload the source so the next seek/play starts fresh.
					console.warn('[HLS] Fatal network error — reloading source…');
					const currentTime = el.currentTime;
					hls!.loadSource(masterUrl);
					hls!.startLoad(currentTime);
				} else {
					console.error('[HLS] Unrecoverable fatal error:', data);
					statusText.set(`Playback failed: ${data.details}`);
				}
			});
		} else if (el.canPlayType('application/vnd.apple.mpegurl')) {
			// Safari native HLS
			el.src = masterUrl;
			el.play().catch(() => {});
		} else {
			statusText.set('This browser supports neither Media Source Extensions nor native HLS.');
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
		track.src = api.getSubtitleUrl(videoPath, localIdx);
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
	api.getDetails(videoPath).then((details) => {
		title.set(details.name);

		const subs = details.streams
			.filter((s): s is ProbeStream & { codec_type: 'subtitle' } => s.codec_type === 'subtitle')
			.map((s, localIdx) => ({
				localIdx,
				name: s.tags?.title ?? s.tags?.language ?? `Track ${localIdx + 1}`,
			}));
		subtitleList.set(subs);

		// ── Compute info bar text ─────────────────────────────────────────────
		const vStream = details.streams.find((s) => s.codec_type === 'video');
		const aStreams = details.streams.filter((s) => s.codec_type === 'audio');

		if (vStream) {
			const codec = vStream.codec_name.toUpperCase();
			const res = vStream.width && vStream.height ? `${vStream.width}×${vStream.height}` : '';
			const fps = parseFps(vStream.r_frame_rate);
			// The backend decides copy-vs-transcode from this browser's own codec
			// support, so show its answer rather than guessing from the codec name.
			const plan = details.video;
			const reason = (plan?.reason ?? '').replace(/"/g, '&quot;');
			const badge =
				plan?.mode === 'copy'
					? ` <span class="hv-badge hv-badge--copy" title="${reason}">copy</span>`
					: ` <span class="hv-badge hv-badge--transcode" title="${reason}">→ H.264</span>`;
			infoVideoText.set(`${codec}${res ? ' · ' + res : ''}${fps ? ' · ' + fps : ''}${badge}`);
		}

		if (aStreams.length) {
			const parts = aStreams.map((s) => {
				const codec = s.codec_name.toUpperCase();
				const ch = s.channels ?? 2;
				const chLabel = ch > 2 ? `${ch}ch` : 'stereo';
				return `${codec} ${chLabel}`;
			});
			// Collapse duplicates: "AAC stereo ×2" instead of listing each
			const collapsed: string[] = [];
			const counts = new Map<string, number>();
			for (const p of parts) counts.set(p, (counts.get(p) ?? 0) + 1);
			for (const [label, n] of counts) collapsed.push(n > 1 ? `${label} ×${n}` : label);
			infoAudioText.set(collapsed.join(', ') + ' <span class="hv-badge hv-badge--transcode">→ AAC stereo</span>');
		}

		if (details.duration) {
			infoDurationText.set(fDuration(details.duration) + ' · ' + fbytes(details.size));
		}
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

		infoToggleBtn: {
			onclick: () => {
				const next = !infoVisible.get();
				infoVisible.set(next);
				prefs.set(PREF_KEYS.INFO_VISIBLE, next);
			},
			classes: { 'is-active': () => infoVisible.get() },
		},

		infoBar: {
			classes: { hidden: () => !infoVisible.get() },
		},

		infoVideo: {
			innerHTML: () => infoVideoText.get() || '…',
		},

		infoAudio: {
			innerHTML: () => infoAudioText.get() || '',
		},

		infoDuration: {
			innerHTML: () => infoDurationText.get() || '',
		},

		playerStatus: {
			inner: () => statusText.get(),
			classes: { hidden: () => !statusText.get() },
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
