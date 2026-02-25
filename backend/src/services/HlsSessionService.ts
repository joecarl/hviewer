import { spawn, ChildProcess } from 'child_process';
import { mkdirSync, existsSync, rmSync, readdirSync } from 'fs';
import path from 'path';
import os from 'os';

const SEG_DURATION = 6; // must match -hls_time
const SEEK_AHEAD_THRESHOLD = 10; // segments (~60 s) before we restart ffmpeg

// ── Types ────────────────────────────────────────────────────────────────────

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

export interface ProbeFormat {
	duration: string; // seconds as string
	bit_rate?: string;
	size?: string;
}

export interface ProbeResult {
	streams: ProbeStream[];
	format: ProbeFormat;
}

export interface HlsSession {
	videoPath: string;
	sessionDir: string;
	probe: ProbeResult;
	audioStreams: ProbeStream[];
	subtitleStreams: ProbeStream[];
	process: ChildProcess | null;
	lastAccess: number;
	startSegment: number; // segment index FFmpeg started from
	totalDuration: number; // seconds (from ffprobe format)
	totalSegments: number; // ceil(totalDuration / SEG_DURATION)
}

// ── Service ───────────────────────────────────────────────────────────────────

export class HlsSessionService {
	private sessions = new Map<string, HlsSession>();
	private cleanupTimer: ReturnType<typeof setInterval>;
	private readonly ffmpegBin: string;
	private readonly ffprobeBin: string;

	constructor() {
		this.ffmpegBin = process.env.FFMPEG_PATH ?? 'ffmpeg';
		this.ffprobeBin = process.env.FFPROBE_PATH ?? 'ffprobe';
		// Clean up idle sessions every minute
		this.cleanupTimer = setInterval(() => this.cleanupIdle(), 60_000);
	}

	// ── ffprobe ────────────────────────────────────────────────────────────────

	probe(videoPath: string): Promise<ProbeResult> {
		return new Promise((resolve, reject) => {
			const proc = spawn(this.ffprobeBin, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', videoPath]);
			let stdout = '';
			let stderr = '';
			proc.stdout.on('data', (d: Buffer) => (stdout += d));
			proc.stderr.on('data', (d: Buffer) => (stderr += d));
			proc.on('close', (code) => {
				if (code === 0) {
					try {
						resolve(JSON.parse(stdout) as ProbeResult);
					} catch {
						reject(new Error('Failed to parse ffprobe output'));
					}
				} else {
					reject(new Error(`ffprobe failed (code ${code}): ${stderr.slice(0, 300)}`));
				}
			});
			proc.on('error', reject);
		});
	}

	// ── Session management ──────────────────────────────────────────────────────

	async getOrCreateSession(videoId: string, videoPath: string): Promise<HlsSession> {
		const existing = this.sessions.get(videoId);
		if (existing) {
			existing.lastAccess = Date.now();
			return existing;
		}

		const probeResult = await this.probe(videoPath);
		const audioStreams = probeResult.streams.filter((s) => s.codec_type === 'audio');
		const subtitleStreams = probeResult.streams.filter((s) => s.codec_type === 'subtitle');
		const totalDuration = parseFloat(probeResult.format.duration) || 0;
		const totalSegments = Math.ceil(totalDuration / SEG_DURATION) || 1;

		const sessionDir = path.join(os.tmpdir(), 'hviewer', videoId);
		mkdirSync(sessionDir, { recursive: true });

		const session: HlsSession = {
			videoPath,
			sessionDir,
			probe: probeResult,
			audioStreams,
			subtitleStreams,
			process: null,
			lastAccess: Date.now(),
			startSegment: 0,
			totalDuration,
			totalSegments,
		};

		this.sessions.set(videoId, session);
		await this.startFfmpeg(session, videoId, 0);

		return session;
	}

	// ── FFmpeg ──────────────────────────────────────────────────────────────────

	private async startFfmpeg(session: HlsSession, videoId: string, startSegment: number): Promise<void> {
		const { videoPath, sessionDir, audioStreams, probe } = session;

		// Create variant subdirectories
		const variantCount = 1 + audioStreams.length;
		for (let i = 0; i < variantCount; i++) {
			mkdirSync(path.join(sessionDir, String(i)), { recursive: true });
		}

		session.startSegment = startSegment;

		// Fast seek: put -ss BEFORE -i so ffmpeg does a keyframe seek
		const args: string[] = [];
		if (startSegment > 0) {
			args.push('-ss', String(startSegment * SEG_DURATION));
		}
		args.push('-i', videoPath);

		// Map video (stream 0) and all audio tracks
		args.push('-map', '0:v:0');
		audioStreams.forEach((_, i) => args.push('-map', `0:a:${i}`));

		// Video codec — copy h264/hevc directly (no re-encode needed for HLS/TS)
		const videoStream = probe.streams.find((s) => s.codec_type === 'video');
		const vCodec = videoStream?.codec_name ?? '';
		if (vCodec === 'h264' || vCodec === 'hevc' || vCodec === 'h265') {
			args.push('-c:v', 'copy');
		} else {
			args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
		}

		// Audio: always re-encode to stereo AAC (browsers can't decode 5.1 AAC via MSE)
		args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2');

		// var_stream_map: "v:0 a:0 a:1 ..."  → variant 0 = video, 1..N = audio
		const streamMapParts = ['v:0', ...audioStreams.map((_, i) => `a:${i}`)];
		args.push('-var_stream_map', streamMapParts.join(' '));

		// HLS options — start_number keeps segment indices absolute across restarts
		args.push(
			'-hls_time',
			String(SEG_DURATION),
			'-hls_list_size',
			'0',
			'-start_number',
			String(startSegment),
			'-hls_segment_filename',
			`${sessionDir}/%v/seg%06d.ts`,
			'-hls_flags',
			'independent_segments',
			`${sessionDir}/%v/stream.m3u8`
		);

		console.log(`[FFmpeg] Starting session ${videoId} from seg ${startSegment}: ${videoPath}`);
		const proc = spawn(this.ffmpegBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
		session.process = proc;

		proc.stderr.on('data', (d: Buffer) => {
			const msg = d.toString();
			if (msg.includes('Error') || msg.includes('Invalid')) {
				console.error(`[FFmpeg] (${videoId}):`, msg.slice(0, 200));
			}
		});
		proc.on('error', (err) => console.error(`[FFmpeg] Error (${videoId}):`, err.message));
		proc.on('close', (code) => console.log(`[FFmpeg] Done (${videoId}), exit=${code}`));

		// Wait until the first segment of this run is ready (up to 45 s)
		const firstSeg = path.join(sessionDir, '0', `seg${String(startSegment).padStart(6, '0')}.ts`);
		await this.waitForFile(firstSeg, 45_000);
	}

	// ── Playlist builder ────────────────────────────────────────────────────────

	buildMasterPlaylist(session: HlsSession, videoId: string): string {
		const { audioStreams } = session;
		const base = `/api/videos/${videoId}/hls`;
		const lines: string[] = ['#EXTM3U', ''];

		// EXT-X-MEDIA for every audio track
		if (audioStreams.length > 0) {
			audioStreams.forEach((s, i) => {
				const isDefault = i === 0 ? 'YES' : 'NO';
				const lang = s.tags?.language ?? `track${i + 1}`;
				const name = s.tags?.title ?? s.tags?.language ?? `Audio ${i + 1}`;
				// variant index: 0=video-only, 1+i=audio track i
				lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="${lang}",NAME="${name}",DEFAULT=${isDefault},URI="${base}/${i + 1}/stream.m3u8"`);
			});
			lines.push('');
		}

		// Single video variant
		const audioAttr = audioStreams.length > 0 ? ',AUDIO="aud"' : '';
		lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=4000000${audioAttr}`);
		lines.push(`${base}/0/stream.m3u8`);

		return lines.join('\n');
	}

	// ── Dynamic VOD variant playlist ────────────────────────────────────────────
	// Serves the complete timeline so hls.js can render a full seekbar.
	// Segments not yet produced by FFmpeg are served on-demand (waitForFile).
	// If startSegment > 0 (after a seek-restart) the missing range is a single
	// #EXT-X-GAP entry so hls.js skips it and jumps to available content.

	buildVariantPlaylist(session: HlsSession, variantIdx: number, videoId: string): string {
		const { totalDuration, totalSegments, startSegment } = session;
		const base = `/api/videos/${videoId}/hls/${variantIdx}`;
		const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEG_DURATION + 1}`, '#EXT-X-PLAYLIST-TYPE:VOD', ''];

		if (startSegment > 0) {
			// Represent the skipped range as a single gap entry so hls.js knows the total duration
			const gapDur = (startSegment * SEG_DURATION).toFixed(6);
			lines.push('#EXT-X-GAP');
			lines.push(`#EXTINF:${gapDur},`);
			lines.push(`${base}/seg000000.ts`); // URL won't be fetched for a GAP
			lines.push('#EXT-X-DISCONTINUITY');
		}

		for (let i = startSegment; i < totalSegments; i++) {
			const isLast = i === totalSegments - 1;
			const dur = isLast ? Math.max(totalDuration - i * SEG_DURATION, 0).toFixed(6) : SEG_DURATION.toFixed(6);
			lines.push(`#EXTINF:${dur},`);
			lines.push(`${base}/seg${String(i).padStart(6, '0')}.ts`);
		}

		lines.push('#EXT-X-ENDLIST');
		return lines.join('\n');
	}

	// ── Segment availability + seek-restart ─────────────────────────────────────

	private getLastProducedSegment(sessionDir: string, variant: string): number {
		const dir = path.join(sessionDir, variant);
		try {
			const nums = readdirSync(dir)
				.filter((f) => /^seg\d+\.ts$/.test(f))
				.map((f) => parseInt(f.slice(3, -3), 10));
			return nums.length ? Math.max(...nums) : -1;
		} catch {
			return -1;
		}
	}

	async ensureSegmentAvailable(session: HlsSession, videoId: string, variant: string, segIdx: number): Promise<string> {
		const segPath = path.join(session.sessionDir, variant, `seg${String(segIdx).padStart(6, '0')}.ts`);
		if (existsSync(segPath)) return segPath;

		const lastProduced = this.getLastProducedSegment(session.sessionDir, variant);

		// If the requested segment is far beyond current progress, restart from it
		if (segIdx > lastProduced + SEEK_AHEAD_THRESHOLD) {
			console.log(`[Seek] Restarting from seg ${segIdx} (last=${lastProduced}) for ${videoId}`);
			await this.restartFfmpegFrom(session, videoId, segIdx);
		}

		await this.waitForFile(segPath, 60_000);
		return segPath;
	}

	private async restartFfmpegFrom(session: HlsSession, videoId: string, startSegment: number): Promise<void> {
		// Kill current FFmpeg process
		session.process?.kill('SIGTERM');
		session.process = null;

		// Remove old segment files so the new run starts clean
		for (const variant of readdirSync(session.sessionDir)) {
			const varDir = path.join(session.sessionDir, variant);
			try {
				for (const f of readdirSync(varDir)) {
					if (f.endsWith('.ts') || f.endsWith('.m3u8') || f.endsWith('.m3u8.tmp')) {
						try {
							rmSync(path.join(varDir, f));
						} catch {}
					}
				}
			} catch {}
		}

		await this.startFfmpeg(session, videoId, startSegment);
	}

	// ── Subtitles ────────────────────────────────────────────────────────────────

	extractSubtitle(videoPath: string, streamIndex: number): Promise<string> {
		return new Promise((resolve, reject) => {
			const proc = spawn(this.ffmpegBin, ['-i', videoPath, '-map', `0:s:${streamIndex}`, '-f', 'webvtt', 'pipe:1']);
			let out = '';
			let err = '';
			proc.stdout.on('data', (d: Buffer) => (out += d));
			proc.stderr.on('data', (d: Buffer) => (err += d));
			proc.on('close', (code) => {
				if (code === 0 && out.includes('WEBVTT')) {
					resolve(out);
				} else {
					reject(new Error(`Subtitle extraction failed (code ${code}): ${err.slice(0, 200)}`));
				}
			});
			proc.on('error', reject);
		});
	}

	// ── Helpers ─────────────────────────────────────────────────────────────────

	waitForFile(filePath: string, timeout: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const start = Date.now();
			const check = () => {
				if (existsSync(filePath)) {
					resolve();
				} else if (Date.now() - start > timeout) {
					reject(new Error(`Timeout waiting for: ${filePath}`));
				} else {
					setTimeout(check, 200);
				}
			};
			check();
		});
	}

	getSession(videoId: string): HlsSession | undefined {
		return this.sessions.get(videoId);
	}

	// ── Cleanup ─────────────────────────────────────────────────────────────────

	private cleanupIdle(): void {
		const maxIdle = 10 * 60 * 1000; // 10 min
		const now = Date.now();
		for (const [id, session] of this.sessions) {
			if (now - session.lastAccess > maxIdle) {
				this.killSession(id);
			}
		}
	}

	killSession(videoId: string): void {
		const session = this.sessions.get(videoId);
		if (!session) return;
		session.process?.kill('SIGTERM');
		try {
			rmSync(session.sessionDir, { recursive: true, force: true });
		} catch {}
		this.sessions.delete(videoId);
		console.log(`[HLS] Session cleaned up: ${videoId}`);
	}
}
