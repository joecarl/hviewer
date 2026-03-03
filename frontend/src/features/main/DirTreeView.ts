import { component, signal } from 'chispa';
import { services } from '../../services/container/ServiceContainer';
import { VideoApiService, type DirEntry, type GenericFileInfo } from '../../services/VideoApiService';
import { fbytes } from '../../utils/formats';
import tpl from './DirTreeView.html';

const INDENT_BASE = 10;
const INDENT_STEP = 14;

interface DirState {
	entries: DirEntry[] | null; // null = not yet loaded
	loading: boolean;
	error: string | null;
}

export interface DirTreeViewProps {
	onSelectVideo: (path: string) => void;
	selectedPath: { get: () => string | null };
	initialFilePath?: string | null;
}

export const DirTreeView = component((props: DirTreeViewProps) => {
	const api = services.get(VideoApiService);

	// ── State ─────────────────────────────────────────────────────────────────
	const rootPath = signal('');
	const expanded = signal<Set<string>>(new Set());
	const dirStates = signal<Map<string, DirState>>(new Map());

	const getState = (p: string): DirState => dirStates.get().get(p) ?? { entries: null, loading: false, error: null };

	const isExpanded = (p: string) => expanded.get().has(p);

	const patchState = (p: string, patch: Partial<DirState>) => {
		const m = new Map(dirStates.get());
		m.set(p, { ...getState(p), ...patch });
		dirStates.set(m);
	};

	// ── Data loading ──────────────────────────────────────────────────────────
	const loadDir = async (dirPath: string) => {
		patchState(dirPath, { loading: true, error: null });
		try {
			const result = await api.browseDir(dirPath);
			if (!rootPath.get()) rootPath.set(result.rootPath);
			patchState(dirPath, { entries: result.entries, loading: false });
		} catch (err) {
			patchState(dirPath, { error: (err as Error).message, loading: false });
		}
	};

	// ── Toggle expand / collapse ──────────────────────────────────────────────
	const toggleDir = (dirPath: string) => {
		const state = getState(dirPath);
		if (!state.entries && !state.loading) {
			loadDir(dirPath);
		}
		const set = new Set(expanded.get());
		if (set.has(dirPath)) {
			set.delete(dirPath);
		} else {
			set.add(dirPath);
		}
		expanded.set(set);
	};

	// ── Auto-expand tree to reach a file path ────────────────────────────────
	const expandToPath = async (root: string, targetFile: string) => {
		if (!targetFile.startsWith(root)) return;
		const relative = targetFile.slice(root.length);
		const parts = relative.split('/').filter(Boolean);
		let current = root;
		for (let i = 0; i < parts.length - 1; i++) {
			current = current + '/' + parts[i];
			if (!getState(current).entries) {
				await loadDir(current);
			}
			const set = new Set(expanded.get());
			set.add(current);
			expanded.set(set);
		}
	};

	// ── Initialise ────────────────────────────────────────────────────────────
	(async () => {
		try {
			const result = await api.browseDir(undefined);
			rootPath.set(result.rootPath);
			patchState(result.rootPath, { entries: result.entries, loading: false });
			const set = new Set<string>();
			set.add(result.rootPath);
			expanded.set(set);
			if (props.initialFilePath) {
				await expandToPath(result.rootPath, props.initialFilePath);
			}
		} catch (err) {
			console.error('DirTreeView init error:', err);
		}
	})();

	// ── Template builders ─────────────────────────────────────────────────────

	const buildVideoNode = (entry: DirEntry & { type: 'video' }, depth: number) =>
		tpl.videoNode({
			onclick: () => props.onSelectVideo(entry.path),
			classes: { 'is-selected': () => props.selectedPath.get() === entry.path },
			style: { paddingLeft: INDENT_BASE + depth * INDENT_STEP + 'px' },
			nodes: {
				videoExt: { inner: entry.ext.replace('.', '').toUpperCase() },
				videoName: { inner: entry.name },
				videoSize: { inner: fbytes(entry.size) },
			},
		});

	const buildFileNode = (entry: GenericFileInfo, depth: number) =>
		tpl.fileNode({
			style: { paddingLeft: INDENT_BASE + depth * INDENT_STEP + 'px' },
			nodes: {
				fileName: { inner: entry.name },
			},
		});

	const buildChildren = (
		dirPath: string,
		depth: number
	): ReturnType<typeof tpl.videoNode | typeof tpl.fileNode | typeof tpl.dirNode | typeof tpl.treeMsg>[] => {
		const state = getState(dirPath);
		const childDepth = depth + 1;
		const indentPx = INDENT_BASE + childDepth * INDENT_STEP + 'px';

		if (state.loading) {
			return [tpl.treeMsg({ inner: 'Loading…', style: { paddingLeft: indentPx } })];
		}
		if (state.error) {
			return [tpl.treeMsg({ addClass: 'hv-tree-error', inner: state.error, style: { paddingLeft: indentPx } })];
		}
		if (!state.entries || state.entries.length === 0) {
			return [tpl.treeMsg({ inner: 'Empty folder', style: { paddingLeft: indentPx } })];
		}
		return state.entries.map((entry) =>
			entry.type === 'dir'
				? buildDirNode(entry.name, entry.path, childDepth)
				: entry.type === 'video'
					? buildVideoNode(entry, childDepth)
					: buildFileNode(entry, childDepth)
		);
	};

	const buildDirNode = (dirName: string, dirPath: string, depth: number): ReturnType<typeof tpl.dirNode> => {
		const exp = isExpanded(dirPath);
		return tpl.dirNode({
			nodes: {
				dirRow: {
					onclick: () => toggleDir(dirPath),
					style: { paddingLeft: INDENT_BASE + depth * INDENT_STEP + 'px' },
				},
				dirIconClosed: { style: { display: exp ? 'none' : '' } },
				dirIconOpen: { style: { display: exp ? '' : 'none' } },
				dirLabel: { inner: dirName },
				dirChildren: {
					style: { display: exp ? '' : 'none' },
					inner: exp ? buildChildren(dirPath, depth) : [],
				},
			},
		});
	};

	// ── Render ────────────────────────────────────────────────────────────────
	return tpl.fragment({
		treeRoot: {
			inner: () => {
				// Track both signals so the tree rebuilds on expand/collapse or data load
				dirStates.get();
				expanded.get();
				const root = rootPath.get();
				if (!root) return tpl.treeMsg({ inner: 'Loading…', style: { padding: '20px 14px' } });
				const rootName = root.split('/').filter(Boolean).pop() || root;
				return buildDirNode(rootName, root, 0);
			},
		},
	});
});
