import { Router } from 'express';
import path from 'path';
import { container } from '../services/container/ServiceContainer';
import { VideoScannerService } from '../services/VideoScannerService';
import { HlsSessionService, parseCaps, planVideo, type VideoMode } from '../services/HlsSessionService';

// ── Session ID helpers ────────────────────────────────────────────────────────
// The session ID is a base64url-encoded absolute file path.
// It serves as a stable, scanless key for HLS sessions and temp directories.

function sessionIdToPath(sessionId: string): string {
	const b64 = sessionId.replace(/-/g, '+').replace(/_/g, '/');
	const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
	return Buffer.from(padded, 'base64').toString('latin1');
}

// ── Client capability helpers ─────────────────────────────────────────────────
// The master playlist resolves copy-vs-transcode from ?caps= (what the browser
// says it can decode) and stamps the answer as ?m= on every URL it emits, so the
// follow-up requests land on that same session without re-probing the file.

function modeFromQuery(raw: unknown): VideoMode | undefined {
	return raw === 'copy' || raw === 'x264' ? raw : undefined;
}

export function videoRoutes(): Router {
	const router = Router();
	const scanner = container.get(VideoScannerService);
	const hlsService = container.get(HlsSessionService);

	// ── Browse a directory (one level, lazy) ──────────────────────────────────

	router.get('/browse', (req, res) => {
		const dir = typeof req.query['dir'] === 'string' ? req.query['dir'] : undefined;
		try {
			const result = scanner.listDir(dir);
			res.json(result);
		} catch (err) {
				res.status(403).json({ error: (err as Error).message });
		}
	});

	// ── Video stream info ──────────────────────────────────────────────────────

	router.get('/info', async (req, res) => {
		const filePath = req.query['path'];
		if (typeof filePath !== 'string' || !filePath) {
			return void res.status(400).json({ error: 'Missing "path" query parameter' });
		}
		try {
			const video = scanner.resolveVideoPath(filePath);
			const probe = await hlsService.probe(video.path);
			const duration = parseFloat(probe.format.duration) || 0;
			const plan = planVideo(
				probe.streams.find((s) => s.codec_type === 'video'),
				parseCaps(req.query['caps'])
			);
			res.json({ name: video.name, size: video.size, streams: probe.streams, duration, video: plan });
		} catch (err) {
				res.status(500).json({ error: (err as Error).message });
		}
	});

	// ── HLS master playlist ────────────────────────────────────────────────────

	router.get('/:sessionId/hls/master.m3u8', async (req, res) => {
		const { sessionId } = req.params;
		try {
			const video = scanner.resolveVideoPath(sessionIdToPath(sessionId));
			// ?force=x264 is the client's escape hatch: it asks for a transcode after the
			// browser rejected a stream our capability probe thought it could decode.
			const forced = req.query['force'] === 'x264' ? ('x264' as VideoMode) : undefined;
			const session = await hlsService.getOrCreateSession(sessionId, video.path, {
				caps: parseCaps(req.query['caps']),
				mode: forced,
			});
			res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
			res.setHeader('Cache-Control', 'no-cache');
			res.send(hlsService.buildMasterPlaylist(session, sessionId));
		} catch (err) {
				res.status(500).json({ error: (err as Error).message });
		}
	});

	// ── HLS variant playlists ─────────────────────────────────────────────────
	// variant "0" = video, "1", "2", ... = audio tracks

	router.get('/:sessionId/hls/:variant/stream.m3u8', async (req, res) => {
		const { sessionId } = req.params;
		if (!/^\d+$/.test(req.params.variant)) {
			return void res.status(400).json({ error: 'Invalid variant name' });
		}
		try {
			const video = scanner.resolveVideoPath(sessionIdToPath(sessionId));
			const session = await hlsService.getOrCreateSession(sessionId, video.path, {
				caps: parseCaps(req.query['caps']),
				mode: modeFromQuery(req.query['m']),
			});
			session.lastAccess = Date.now();
			const variantIdx = parseInt(req.params.variant, 10);
			res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
			res.setHeader('Cache-Control', 'no-cache');
			res.send(hlsService.buildVariantPlaylist(session, variantIdx, sessionId));
		} catch (err) {
				res.status(500).json({ error: (err as Error).message });
		}
	});

	// ── HLS segments ──────────────────────────────────────────────────────────

	router.get('/:sessionId/hls/:variant/:segment', async (req, res) => {
		const { sessionId } = req.params;
		const segment = path.basename(req.params.segment);
		if (!segment.startsWith('seg') || !segment.endsWith('.ts') || !/^\d+$/.test(req.params.variant)) {
			return void res.status(400).json({ error: 'Bad request' });
		}
		const segIdx = parseInt(segment.slice(3, -3), 10);
		try {
			const video = scanner.resolveVideoPath(sessionIdToPath(sessionId));
			const session = await hlsService.getOrCreateSession(sessionId, video.path, {
				caps: parseCaps(req.query['caps']),
				mode: modeFromQuery(req.query['m']),
			});
			session.lastAccess = Date.now();
			const segPath = await hlsService.ensureSegmentAvailable(session, sessionId, req.params.variant, segIdx);
			res.setHeader('Content-Type', 'video/MP2T');
			res.sendFile(segPath);
		} catch (err) {
				res.status(500).json({ error: (err as Error).message });
		}
	});

	// ── Subtitle tracks as WebVTT ──────────────────────────────────────────────

	router.get('/:sessionId/subs/:idx.vtt', async (req, res) => {
		const idx = parseInt(req.params.idx, 10);
		if (isNaN(idx) || idx < 0) return void res.status(400).json({ error: 'Invalid subtitle index' });
		try {
			const video = scanner.resolveVideoPath(sessionIdToPath(req.params.sessionId));
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
