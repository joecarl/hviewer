import { Router } from 'express';
import path from 'path';
import { container } from '../services/container/ServiceContainer';
import { VideoScannerService } from '../services/VideoScannerService';
import { HlsSessionService } from '../services/HlsSessionService';

export function videoRoutes(): Router {
	const router = Router();
	const scanner = container.get(VideoScannerService);
	const hlsService = container.get(HlsSessionService);

	// ── Find video by file path ────────────────────────────────────────────────

	router.get('/by-path', (req, res) => {
		const filePath = req.query['path'];
		if (typeof filePath !== 'string' || !filePath) {
			return void res.status(400).json({ error: 'Missing "path" query parameter' });
		}
		const video = scanner.findByPath(filePath);
		if (!video) return void res.status(404).json({ error: 'Video not found' });
		res.json(video);
	});

	// ── List all videos ────────────────────────────────────────────────────────

	router.get('/', (_req, res) => {
		const videos = scanner.scan();
		res.json(videos);
	});

	// ── Stream info ─────────────────────────────────────────────────────────────

	router.get('/:id/info', async (req, res) => {
		const video = scanner.findById(req.params.id);
		if (!video) return void res.status(404).json({ error: 'Video not found' });

		try {
			const probe = await hlsService.probe(video.path);
			res.json({ videoId: video.id, name: video.name, size: video.size, streams: probe.streams });
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});

	// ── HLS master playlist ─────────────────────────────────────────────────────

	router.get('/:id/hls/master.m3u8', async (req, res) => {
		const video = scanner.findById(req.params.id);
		if (!video) return void res.status(404).json({ error: 'Video not found' });

		try {
			const session = await hlsService.getOrCreateSession(req.params.id, video.path);
			res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
			res.setHeader('Cache-Control', 'no-cache');
			res.send(hlsService.buildMasterPlaylist(session, req.params.id));
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});

	// ── HLS variant playlists — /:variant/stream.m3u8
	// variant "0" = video, "1", "2", ... = audio tracks  ──────────────────────

	router.get('/:id/hls/:variant/stream.m3u8', async (req, res) => {
		const video = scanner.findById(req.params.id);
		if (!video) return void res.status(404).json({ error: 'Video not found' });

		try {
			const session = await hlsService.getOrCreateSession(req.params.id, video.path);
			session.lastAccess = Date.now();

			// variant dirs are named "0", "1", "2" etc. (FFmpeg %v pattern)
			if (!/^\d+$/.test(req.params.variant)) {
				return void res.status(400).json({ error: 'Invalid variant name' });
			}

			const playlistPath = path.join(session.sessionDir, req.params.variant, 'stream.m3u8');
			await hlsService.waitForFile(playlistPath, 30_000);

			res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
			res.setHeader('Cache-Control', 'no-cache');
			res.sendFile(playlistPath);
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});

	// ── HLS segments ────────────────────────────────────────────────────────────

	router.get('/:id/hls/:variant/:segment', async (req, res) => {
		const video = scanner.findById(req.params.id);
		if (!video) return void res.status(404).json({ error: 'Video not found' });

		const segment = path.basename(req.params.segment);
		if (!segment.endsWith('.ts') || !/^\d+$/.test(req.params.variant)) {
			return void res.status(400).json({ error: 'Bad request' });
		}

		try {
			const session = await hlsService.getOrCreateSession(req.params.id, video.path);
			session.lastAccess = Date.now();

			const segPath = path.join(session.sessionDir, req.params.variant, segment);
			await hlsService.waitForFile(segPath, 30_000);

			res.setHeader('Content-Type', 'video/MP2T');
			res.sendFile(segPath);
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});

	// ── Subtitle tracks as WebVTT ────────────────────────────────────────────────

	router.get('/:id/subs/:idx.vtt', async (req, res) => {
		const video = scanner.findById(req.params.id);
		if (!video) return void res.status(404).json({ error: 'Video not found' });

		const idx = parseInt(req.params.idx, 10);
		if (isNaN(idx) || idx < 0) return void res.status(400).json({ error: 'Invalid subtitle index' });

		try {
			const vtt = await hlsService.extractSubtitle(video.path, idx);
			res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
			res.setHeader('Cache-Control', 'public, max-age=3600');
			res.send(vtt);
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});

	return router;
}
