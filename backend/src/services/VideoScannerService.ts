import { readdirSync, statSync } from 'fs';
import path from 'path';
import crypto from 'crypto';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.ts', '.m2ts', '.mpg', '.mpeg', '.ogv', '.3gp']);

export interface VideoFile {
	id: string;
	name: string;
	path: string;
	size: number;
	ext: string;
}

export class VideoScannerService {
	private readonly videoPath: string;

	constructor() {
		this.videoPath = process.env.VIDEO_PATH || '/videos';
	}

	getVideoPath(): string {
		return this.videoPath;
	}

	scan(): VideoFile[] {
		const results: VideoFile[] = [];
		try {
			this.scanDir(this.videoPath, results);
		} catch (err) {
			console.warn(`Cannot scan directory ${this.videoPath}:`, (err as Error).message);
		}
		// Sort by name
		results.sort((a, b) => a.name.localeCompare(b.name));
		return results;
	}

	private scanDir(dir: string, results: VideoFile[]): void {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				this.scanDir(fullPath, results);
			} else if (entry.isFile()) {
				const ext = path.extname(entry.name).toLowerCase();
				if (VIDEO_EXTENSIONS.has(ext)) {
					const stats = statSync(fullPath);
					const id = crypto.createHash('sha256').update(fullPath).digest('hex');
					results.push({
						id,
						name: path.basename(entry.name, ext),
						path: fullPath,
						size: stats.size,
						ext,
					});
				}
			}
		}
	}

	findById(id: string): VideoFile | undefined {
		return this.scan().find((v) => v.id === id);
	}

	findByPath(filePath: string): VideoFile | undefined {
		const resolved = path.resolve(filePath);
		// Security: ensure the file is within the configured video directory
		const videoRoot = path.resolve(this.videoPath);
		if (!resolved.startsWith(videoRoot + path.sep) && resolved !== videoRoot) {
			return undefined;
		}
		return this.scan().find((v) => v.path === resolved);
	}
}
