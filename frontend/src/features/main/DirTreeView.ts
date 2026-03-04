import { component, signal, componentList, computed, appendChild } from 'chispa';
import type { Signal, WritableSignal } from 'chispa';
import { services } from '../../services/container/ServiceContainer';
import { VideoApiService, type DirEntry, type GenericFileInfo } from '../../services/VideoApiService';
import { fbytes } from '../../utils/formats';
import tpl from './DirTreeView.html';

const INDENT_BASE = 10;
const INDENT_STEP = 14;

/** Sentinel entry used to show loading / error / empty-folder messages inside a dir */
type MsgEntry = { type: 'msg'; text: string; isError?: boolean };
type TreeDisplayEntry = DirEntry | MsgEntry;

export interface DirTreeViewProps {
	onSelectVideo: (path: string) => void;
	selectedPath: { get: () => string | null };
	initialFilePath?: string | null;
}

export const DirTreeView = component((props: DirTreeViewProps) => {
	const api = services.get(VideoApiService);

	// ── Per-directory signals (created lazily) ────────────────────────────────
	const rootPath = signal('');
	const perDirEntries = new Map<string, WritableSignal<TreeDisplayEntry[]>>();
	const perDirExpanded = new Map<string, WritableSignal<boolean>>();
	/** Plain set (non-reactive) – only used to prevent double-loads */
	const loadedDirs = new Set<string>();

	const getDirEntriesSignal = (path: string): WritableSignal<TreeDisplayEntry[]> => {
		if (!perDirEntries.has(path)) perDirEntries.set(path, signal<TreeDisplayEntry[]>([]));
		return perDirEntries.get(path)!;
	};

	const getDirExpandedSignal = (path: string): WritableSignal<boolean> => {
		if (!perDirExpanded.has(path)) perDirExpanded.set(path, signal(false));
		return perDirExpanded.get(path)!;
	};

	// ── Data loading ──────────────────────────────────────────────────────────
	const loadDir = async (dirPath: string) => {
		getDirEntriesSignal(dirPath).set([{ type: 'msg', text: 'Loading…' }]);
		try {
			const result = await api.browseDir(dirPath);
			if (!rootPath.get()) rootPath.set(result.rootPath);
			loadedDirs.add(dirPath);
			getDirEntriesSignal(dirPath).set(result.entries.length > 0 ? result.entries : [{ type: 'msg', text: 'Empty folder' }]);
		} catch (err) {
			getDirEntriesSignal(dirPath).set([{ type: 'msg', text: (err as Error).message, isError: true }]);
		}
	};

	// ── Toggle expand / collapse ──────────────────────────────────────────────
	const toggleDir = (dirPath: string) => {
		if (!loadedDirs.has(dirPath)) loadDir(dirPath);
		const expSig = getDirExpandedSignal(dirPath);
		expSig.set(!expSig.get());
	};

	// ── Auto-expand tree to reach a file path ────────────────────────────────
	const expandToPath = async (root: string, targetFile: string) => {
		if (!targetFile.startsWith(root)) return;
		const relative = targetFile.slice(root.length);
		const parts = relative.split('/').filter(Boolean);
		let current = root;
		for (let i = 0; i < parts.length - 1; i++) {
			current = current + '/' + parts[i];
			if (!loadedDirs.has(current)) await loadDir(current);
			getDirExpandedSignal(current).set(true);
		}
	};

	// ── Initialise ────────────────────────────────────────────────────────────
	(async () => {
		try {
			const result = await api.browseDir(undefined);
			rootPath.set(result.rootPath);
			loadedDirs.add(result.rootPath);
			getDirEntriesSignal(result.rootPath).set(result.entries.length > 0 ? result.entries : [{ type: 'msg', text: 'Empty folder' }]);
			getDirExpandedSignal(result.rootPath).set(true);
			if (props.initialFilePath) {
				await expandToPath(result.rootPath, props.initialFilePath);
			}
		} catch (err) {
			console.error('DirTreeView init error:', err);
		}
	})();

	// ── Template builders ─────────────────────────────────────────────────────

	const DirChildren = componentList<TreeDisplayEntry, { depth: number }>(
		(itemSig, _idx, _list, clProps) => {
			// `type` never changes for a given key — safe to read once for branching
			const childDepth = (clProps?.depth ?? 0) + 1;
			const indentPx = `${INDENT_BASE + childDepth * INDENT_STEP}px`;
			const typeSig = computed(() => itemSig.get().type);

			const content = () => {
				const type = typeSig.get();
				if (type === 'msg') {
					const msgEntry = computed(() => itemSig.get() as MsgEntry);
					return tpl.treeMsg({
						classes: { 'hv-tree-error': () => !!msgEntry.get().isError },
						inner: () => msgEntry.get().text,
						style: { paddingLeft: indentPx },
					});
				}
				if (type === 'video') {
					const videoEntry = computed(() => itemSig.get() as DirEntry & { type: 'video' });
					return tpl.videoNode({
						onclick: () => props.onSelectVideo(videoEntry.get().path),
						classes: { 'is-selected': () => props.selectedPath.get() === videoEntry.get().path },
						style: { paddingLeft: indentPx },
						nodes: {
							videoExt: { inner: () => videoEntry.get().ext.replace('.', '').toUpperCase() },
							videoName: { inner: () => videoEntry.get().name },
							videoSize: { inner: () => fbytes(videoEntry.get().size) },
						},
					});
				}
				if (type === 'file') {
					const fileEntry = computed(() => itemSig.get() as GenericFileInfo);
					return tpl.fileNode({
						style: { paddingLeft: indentPx },
						nodes: {
							fileName: { inner: () => fileEntry.get().name },
						},
					});
				}
				// type === 'dir' — recursive: each subdir gets its own ComponentList
				const dirEntry = computed(() => itemSig.get() as DirEntry & { type: 'dir' });
				return buildDirNode(dirEntry, childDepth);
			};
			const frag = document.createDocumentFragment();
			appendChild(frag, content);
			return frag;
		},
		(item) => (item.type === 'msg' ? '__status__' : item.path)
	);

	// function declaration so it is hoisted and reachable from buildDirChildren above
	function buildDirNode(dirEntry: Signal<DirEntry>, depth: number): ReturnType<typeof tpl.dirNode> {
		const expSig = computed(() => getDirExpandedSignal(dirEntry.get().path).get());
		const entriesSig = computed(() => getDirEntriesSignal(dirEntry.get().path).get());
		return tpl.dirNode({
			nodes: {
				dirRow: {
					onclick: () => toggleDir(dirEntry.get().path),
					style: { paddingLeft: INDENT_BASE + depth * INDENT_STEP + 'px' },
				},
				dirIconClosed: { style: { display: () => (expSig.get() ? 'none' : '') } },
				dirIconOpen: { style: { display: () => (expSig.get() ? '' : 'none') } },
				dirLabel: { inner: () => dirEntry.get().name },
				dirChildren: {
					style: { display: () => (expSig.get() ? '' : 'none') },
					inner: DirChildren(entriesSig, { depth }),
				},
			},
		});
	}

	const rootEntry = computed(() => {
		const root = rootPath.get();
		const rootName = root.split('/').filter(Boolean).pop() || root;
		return { name: rootName, path: root, type: 'dir' } as DirEntry;
	});

	// ── Render ────────────────────────────────────────────────────────────────
	return tpl.fragment({
		treeRoot: {
			inner: () => {
				const root = rootPath.get();
				if (!root) return tpl.treeMsg({ inner: 'Loading…', style: { padding: '20px 14px' } });
				return buildDirNode(rootEntry, 0);
			},
		},
	});
});
