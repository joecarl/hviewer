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

export interface VideoDetails {
	name: string;
	size: number;
	streams: ProbeStream[];
	duration: number; // seconds
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
		return this.request<VideoDetails>(`/info?path=${encodeURIComponent(filePath)}`);
	}

	// Raw URLs — consumed by hls.js directly, must not go through the fetch wrapper
	getMasterPlaylistUrl(filePath: string): string {
		return `${this.baseUrl}/${VideoApiService.pathToSessionId(filePath)}/hls/master.m3u8`;
	}

	getSubtitleUrl(filePath: string, streamIndex: number): string {
		return `${this.baseUrl}/${VideoApiService.pathToSessionId(filePath)}/subs/${streamIndex}.vtt`;
	}

	async browseDir(dir?: string): Promise<DirBrowseResult> {
		const query = dir ? `?dir=${encodeURIComponent(dir)}` : '';
		return this.request<DirBrowseResult>(`/browse${query}`);
	}
}
