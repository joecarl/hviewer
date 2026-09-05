// Types returned by the backend
export interface VideoInfo {
	// path is the unique identity — no hash id needed
	name: string;
	path: string;
	size: number;
	ext: string;
}

export interface DirSubdir {
	type: 'dir';
	name: string;
	path: string;
}

export interface GenericFileInfo {
	type: 'file';
	name: string;
	path: string;
	ext: string;
}

export type DirEntry = DirSubdir | (VideoInfo & { type: 'video' }) | GenericFileInfo;

export interface DirBrowseResult {
	rootPath: string;
	dir: string;
	entries: DirEntry[];
}

export interface ProbeStream {
	index: number;
	codec_type: 'video' | 'audio' | 'subtitle' | string;
	codec_name: string;
	tags?: { language?: string; title?: string };
	// video
	width?: number;
	height?: number;
	r_frame_rate?: string;
	pix_fmt?: string;
	// audio
	channels?: number;
	channel_layout?: string;
	sample_rate?: string;
}

export interface VideoPlan {
	mode: 'copy' | 'x264';
	reason: string;
}

export interface VideoDetails {
	name: string;
	size: number;
	streams: ProbeStream[];
	duration: number; // seconds
	video: VideoPlan; // what the backend will do with the video stream for *this* client
}

// ── Client codec capabilities ────────────────────────────────────────────────
// HEVC support is a property of the browser and the machine, not of the file:
// Safari decodes it, Firefox essentially never does, and Chrome only does when
// there is a hardware decoder. The backend can't guess, so we measure it here and
// send the answer along — otherwise it would remux HEVC straight to a browser
// that has no decoder for it and playback dies on an opaque media error.

function detectVideoCaps(): string {
	const caps: string[] = [];
	try {
		// hls.js remuxes into fMP4 and feeds MSE, so MediaSource is the authority.
		// Without it (iOS Safari's native HLS path) the element's own check is.
		const MS = (globalThis as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource ?? globalThis.MediaSource;
		const probeEl = document.createElement('video');
		const canDecode = (mime: string): boolean => (typeof MS?.isTypeSupported === 'function' ? MS.isTypeSupported(mime) : probeEl.canPlayType(mime) !== '');

		// hvc1/hev1 are the same codec under two sample-entry tags; browsers are
		// inconsistent about which one they advertise, so accept either.
		if (canDecode('video/mp4; codecs="hvc1.1.6.L93.B0"') || canDecode('video/mp4; codecs="hev1.1.6.L93.B0"')) caps.push('hevc');
		if (canDecode('video/mp4; codecs="hvc1.2.4.L120.B0"') || canDecode('video/mp4; codecs="hev1.2.4.L120.B0"')) caps.push('hevc10');
	} catch {
		// Any failure means we report nothing and the backend transcodes — the safe side.
	}
	return caps.join(',');
}

let cachedCaps: string | null = null;

export function videoCaps(): string {
	if (cachedCaps === null) cachedCaps = detectVideoCaps();
	return cachedCaps;
}

import { BaseApiService } from './BaseApiService';

export class VideoApiService extends BaseApiService {
	constructor() {
		super('/api/videos');
	}

	// Encode an absolute server path as a base64url session ID (mirrors backend)
	static pathToSessionId(filePath: string): string {
		return btoa(filePath).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
	}

	async getDetails(filePath: string): Promise<VideoDetails> {
		return this.request<VideoDetails>(`/info?path=${encodeURIComponent(filePath)}&caps=${videoCaps()}`);
	}

	// Raw URLs — consumed by hls.js directly, must not go through the fetch wrapper
	// forceTranscode is the fallback for when the browser rejects a stream our
	// capability probe said it could decode.
	getMasterPlaylistUrl(filePath: string, forceTranscode = false): string {
		const params = new URLSearchParams({ caps: videoCaps() });
		if (forceTranscode) params.set('force', 'x264');
		return `${this.baseUrl}/${VideoApiService.pathToSessionId(filePath)}/hls/master.m3u8?${params}`;
	}

	getSubtitleUrl(filePath: string, streamIndex: number): string {
		return `${this.baseUrl}/${VideoApiService.pathToSessionId(filePath)}/subs/${streamIndex}.vtt`;
	}

	async browseDir(dir?: string): Promise<DirBrowseResult> {
		const query = dir ? `?dir=${encodeURIComponent(dir)}` : '';
		return this.request<DirBrowseResult>(`/browse${query}`);
	}
}
