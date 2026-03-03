import { readdirSync, statSync } from 'fs';
import path from 'path';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.ts', '.m2ts', '.mpg', '.mpeg', '.ogv', '.3gp']);

export interface VideoFile {
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

export interface GenericFile {
	type: 'file';
	name: string;
	path: string;
	ext: string;
}

export type DirEntry = DirSubdir | (VideoFile & { type: 'video' }) | GenericFile;

export interface DirBrowseResult {
	rootPath: string;
	dir: string;
	entries: DirEntry[];
}

export class VideoScannerService {
	private readonly videoPath: string;

	constructor() {
		this.videoPath = process.env.VIDEO_PATH || '/videos';
	}

	getVideoPath(): string {
		return this.videoPath;
	}

	// Validate that filePath is inside the video root, stat it, return VideoFile.
	// Throws if the path escapes the root or the file does not exist.
	resolveVideoPath(filePath: string): VideoFile {
		const videoRoot = path.resolve(this.videoPath);
		const resolved = path.resolve(filePath);
		if (resolved !== videoRoot && !resolved.startsWith(videoRoot + path.sep)) {
			throw new Error('Access denied');
		}
		const ext = path.extname(resolved).toLowerCase();
		if (!VIDEO_EXTENSIONS.has(ext)) {
			throw new Error('Not a video file');
		}
		const stats = statSync(resolved);
		return {
			name: path.basename(resolved, ext),
			path: resolved,
			size: stats.size,
			ext,
		};
	}

	listDir(dirPath?: string): DirBrowseResult {
		const videoRoot = path.resolve(this.videoPath);
		const resolved = path.resolve(dirPath ?? videoRoot);

		// Security: must be inside the video root
		if (resolved !== videoRoot && !resolved.startsWith(videoRoot + path.sep)) {
			throw new Error('Access denied');
		}

		const entries: DirEntry[] = [];
		const rawEntries = readdirSync(resolved, { withFileTypes: true });

		for (const entry of rawEntries) {
			const fullPath = path.join(resolved, entry.name);
			if (entry.isDirectory()) {
				entries.push({ type: 'dir', name: entry.name, path: fullPath });
			} else if (entry.isFile()) {
				const ext = path.extname(entry.name).toLowerCase();
				if (VIDEO_EXTENSIONS.has(ext)) {
					const stats = statSync(fullPath);
					entries.push({
						type: 'video',
						name: path.basename(entry.name, ext),
						path: fullPath,
						size: stats.size,
						ext,
					});
				} else {
					entries.push({ type: 'file', name: entry.name, path: fullPath, ext });
				}
			}
		}

		// Sort: dirs first, then files/videos alphabetically
		entries.sort((a, b) => {
			if (a.type === 'dir' && b.type !== 'dir') return -1;
			if (a.type !== 'dir' && b.type === 'dir') return 1;
			return a.name.localeCompare(b.name);
		});

	return { rootPath: videoRoot, dir: resolved, entries };
}
}
