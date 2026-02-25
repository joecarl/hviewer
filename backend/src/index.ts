import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';

import { __APP_MANIFEST__ } from './app-env';
import { container } from './services/container/ServiceContainer';
import { VideoScannerService } from './services/VideoScannerService';
import { HlsSessionService } from './services/HlsSessionService';
import { videoRoutes } from './routes/videoRoutes';

console.log(`Starting hViewer backend v${__APP_MANIFEST__.version}...`);

const app = express();
const port = process.env.PORT || 8945;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Services ─────────────────────────────────────────────────────────────────

const scanner = new VideoScannerService();
container.register(VideoScannerService, scanner);

const hlsService = new HlsSessionService();
container.register(HlsSessionService, hlsService);

// ── Routes ───────────────────────────────────────────────────────────────────

app.use('/api/videos', videoRoutes());

// ── Static / SPA ─────────────────────────────────────────────────────────────

const publicPath = path.join(__dirname, '../public');
app.use(express.static(publicPath));

app.get(/.*/, (req, res, next) => {
	if (req.path.startsWith('/api')) return next();
	res.sendFile(path.join(publicPath, 'index.html'), (err) => {
		if (err) res.status(200).send('hViewer is running (frontend not found)');
	});
});

app.use((req, _res, next) => {
	console.log(`Unhandled: ${req.method} ${req.originalUrl}`);
	next();
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(port, () => {
	console.log(`hViewer listening on port ${port}`);
	console.log(`Video path: ${process.env.VIDEO_PATH ?? '/videos'}`);
});
