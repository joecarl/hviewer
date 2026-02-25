import { spawn, ChildProcess } from 'child_process';
import { mkdirSync, existsSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProbeStream {
	index: number;
	codec_type: 'video' | 'audio' | 'subtitle' | string;
	codec_name: string;
	tags?: { language?: string; title?: string };
}

export interface ProbeResult {
	streams: ProbeStream[];
}

export interface HlsSession {
	videoPath: string;
	sessionDir: string;
	probe: ProbeResult;
	audioStreams: ProbeStream[];
	subtitleStreams: ProbeStream[];
	process: ChildProcess | null;
	lastAccess: number;
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
			const proc = spawn(this.ffprobeBin, ['-v', 'quiet', '-print_format', 'json', '-show_streams', videoPath]);
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
		};

		this.sessions.set(videoId, session);
		await this.startFfmpeg(session, videoId);

		return session;
	}

	// ── FFmpeg ──────────────────────────────────────────────────────────────────

	private async startFfmpeg(session: HlsSession, videoId: string): Promise<void> {
		const { videoPath, sessionDir, audioStreams } = session;

		// Build argument list
		const args: string[] = ['-i', videoPath];

		// Map video (stream 0) and all audio tracks
		args.push('-map', '0:v:0');
		audioStreams.forEach((_, i) => args.push('-map', `0:a:${i}`));

		// Codecs
		args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23');
		args.push('-c:a', 'aac', '-b:a', '128k');

		// Force pixel format (compatibility)
		args.push('-pix_fmt', 'yuv420p');

		// var_stream_map: "v:0 a:0 a:1 ..."
		// → variant 0 = video only, variant 1..N = audio tracks
		const streamMapParts = ['v:0', ...audioStreams.map((_, i) => `a:${i}`)];
		args.push('-var_stream_map', streamMapParts.join(' '));

		// HLS options
		args.push(
			'-hls_time',
			'6',
			'-hls_list_size',
			'0',
			'-hls_segment_filename',
			`${sessionDir}/%v/seg%06d.ts`,
			'-hls_flags',
			'independent_segments',
			`${sessionDir}/%v/stream.m3u8`
		);

		console.log(`[FFmpeg] Starting session ${videoId}: ${videoPath}`);
		const proc = spawn(this.ffmpegBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
		session.process = proc;

		proc.on('error', (err) => console.error(`[FFmpeg] Error (${videoId}):`, err.message));
		proc.on('close', (code) => console.log(`[FFmpeg] Done (${videoId}), exit=${code}`));

		// Wait until the video variant playlist is ready (up to 45 s)
		await this.waitForFile(path.join(sessionDir, '0', 'stream.m3u8'), 45_000);
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
