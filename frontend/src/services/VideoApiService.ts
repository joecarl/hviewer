// Types returned by the backend
export interface VideoInfo {
	id: string;
	name: string;
	size: number;
	ext: string;
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
	videoId: string;
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

	async getVideos(): Promise<VideoInfo[]> {
		return this.request<VideoInfo[]>('');
	}

	async getDetails(videoId: string): Promise<VideoDetails> {
		return this.request<VideoDetails>(`/${videoId}/info`);
	}

	// Raw URLs — consumed by hls.js directly, must not go through the fetch wrapper
	getMasterPlaylistUrl(videoId: string): string {
		return `${this.baseUrl}/${videoId}/hls/master.m3u8`;
	}

	getSubtitleUrl(videoId: string, streamIndex: number): string {
		return `${this.baseUrl}/${videoId}/subs/${streamIndex}.vtt`;
	}

	async getVideoByPath(filePath: string): Promise<VideoInfo> {
		return this.request<VideoInfo>(`/by-path?path=${encodeURIComponent(filePath)}`);
	}
}
