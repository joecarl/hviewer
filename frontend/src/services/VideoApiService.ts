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

export class VideoApiService {
	async getVideos(): Promise<VideoInfo[]> {
		const res = await fetch('/api/videos');
		if (!res.ok) throw new Error(`Failed to list videos: ${res.status}`);
		return res.json();
	}

	async getDetails(videoId: string): Promise<VideoDetails> {
		const res = await fetch(`/api/videos/${videoId}/info`);
		if (!res.ok) throw new Error(`Failed to get video info: ${res.status}`);
		return res.json();
	}

	getMasterPlaylistUrl(videoId: string): string {
		return `/api/videos/${videoId}/hls/master.m3u8`;
	}

	getSubtitleUrl(videoId: string, streamIndex: number): string {
		return `/api/videos/${videoId}/subs/${streamIndex}.vtt`;
	}

	async getVideoByPath(filePath: string): Promise<VideoInfo> {
		const res = await fetch(`/api/videos/by-path?path=${encodeURIComponent(filePath)}`);
		if (!res.ok) throw new Error(`Video not found for path: ${filePath}`);
		return res.json();
	}
}
