import { App, FileSystemAdapter, ItemView, Modal, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import { Language, parseDocPath } from './paths';
import { showPageMenu } from './page-actions';
import { NewPageModal } from './new-page-modal';
import { NewVersionModal } from './new-version-modal';
import { HelpModal } from './help-modal';
import { DocFrontmatter } from './types';
import {
    WeightsJson,
    compareChapters,
    compareDoctypes,
    readWeights,
} from './weights';
import {
    GitFile,
    GitUpstream,
    commit as gitCommit,
    fetch as gitFetch,
    getStatusAndUpstream,
    isGitAvailable,
    pull as gitPull,
    push as gitPush,
    stagePaths,
    unstagePaths,
} from './git';
import type DocsCmsPlugin from './main';

export const CMS_TREE_VIEW_TYPE = 'docs-cms-tree';

interface PageNode {
    file: TFile;
    title: string;
    weight: number;
    status: string;
    bucket: string;
    chapterDir: string;
    doctypeDir: string;
    isIndex: boolean;
}

/** One row in the Staged or Changes section. A single file can produce two entries. */
interface ChangeEntry {
    file: GitFile;
    /** The letter shown in the status badge — index column for staged side, working column for unstaged side. */
    statusLetter: string;
    kind: GitFile['kind'];
}

const DRAG_MIME = 'application/x-docs-cms-page';

type Mode = 'browse' | 'commit';

/**
 * The main CMS sidebar.
 *
 * Two modes:
 *  - `browse` — full tree of versions × languages × buckets × doctype × chapter × pages.
 *  - `commit` — VS-Code-style source-control panel: only changed files, message
 *    field, Commit / Sync buttons. Toggled by the Commit toolbar button.
 */
export class CmsTreeView extends ItemView {
    private plugin: DocsCmsPlugin;
    private version: string;
    private language: Language;
    private weights: WeightsJson = {};

    private mode: Mode = 'browse';
    private gitFiles: GitFile[] = [];
    private gitUpstream: GitUpstream | null = null;
    private gitAvailable = false;
    /** Path → first GitFile entry. Used for status badges in browse-mode tree rows. */
    private gitFileMap: Map<string, GitFile> = new Map();
    private commitMessage = '';
    private gitBusy = false;

    constructor(leaf: WorkspaceLeaf, plugin: DocsCmsPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.language = plugin.settings.defaultLanguage;
        this.version = plugin.detectVersions()[0] ?? 'v1.0.0';
    }

    getViewType(): string {
        return CMS_TREE_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'Docs CMS';
    }

    getIcon(): string {
        return 'book-open';
    }

    async onOpen() {
        await this.refresh();
        this.registerEvent(this.app.vault.on('create', () => this.refresh()));
        this.registerEvent(this.app.vault.on('delete', () => this.refresh()));
        this.registerEvent(this.app.vault.on('rename', () => this.refresh()));
        this.registerEvent(this.app.metadataCache.on('changed', () => this.refresh()));
    }

    private scheduledRefresh: number | null = null;

    async refresh() {
        if (this.scheduledRefresh !== null) return;
        this.scheduledRefresh = window.setTimeout(async () => {
            this.scheduledRefresh = null;
            await this.reloadGitState();
            this.weights = await readWeights(this.app, this.version);
            this.render();
        }, 50);
    }

    private getRepoCwd(): string | null {
        const adapter = this.app.vault.adapter;
        if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
        return null;
    }

    private async reloadGitState() {
        const cwd = this.getRepoCwd();
        if (!cwd) {
            this.gitAvailable = false;
            return;
        }
        try {
            this.gitAvailable = await isGitAvailable(cwd);
            if (!this.gitAvailable) return;
            const { files, upstream } = await getStatusAndUpstream(cwd);
            this.gitFiles = files;
            this.gitUpstream = upstream;
            this.gitFileMap = new Map(files.map((f) => [f.path, f]));
        } catch (e) {
            console.warn('[docs-cms] git status failed:', e);
            this.gitAvailable = false;
        }
    }

    private render() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('docs-cms-tree');

        if (this.mode === 'commit') {
            this.renderCommitMode(contentEl);
            return;
        }

        this.renderBrowseToolbar(contentEl);

        const versions = this.plugin.detectVersions();
        if (versions.length === 0) {
            contentEl.createEl('p', {
                text: 'No CMS versions detected. Expected folders matching v*.*.* at the vault root.',
                cls: 'docs-cms-tree-empty',
            });
            return;
        }

        const allPages = this.collectPages();
        const drafts = allPages.filter((p) => p.bucket === this.plugin.config.structure.draftsBucket);
        const publics = allPages.filter((p) => p.bucket === this.plugin.config.structure.publicBucket);

        const draftsBlock = contentEl.createEl('details', { cls: 'docs-cms-tree-bucket bucket-drafts' });
        if (drafts.length > 0) draftsBlock.setAttribute('open', '');
        const draftsSummary = draftsBlock.createEl('summary');
        draftsSummary.createSpan({ cls: 'docs-cms-tree-bucket-icon', text: '📝' });
        draftsSummary.createSpan({ text: ` Drafts · ${drafts.length}` });
        if (drafts.length === 0) {
            draftsBlock.createEl('p', { text: 'No drafts.', cls: 'docs-cms-tree-empty' });
        } else {
            this.renderFlatList(draftsBlock, drafts);
        }

        const publicBlock = contentEl.createEl('details', { cls: 'docs-cms-tree-bucket bucket-public' });
        publicBlock.setAttribute('open', '');
        const publicSummary = publicBlock.createEl('summary');
        publicSummary.createSpan({ cls: 'docs-cms-tree-bucket-icon', text: '📖' });
        publicSummary.createSpan({ text: ` Public · ${publics.length}` });
        if (publics.length === 0) {
            publicBlock.createEl('p', { text: 'No published pages.', cls: 'docs-cms-tree-empty' });
        } else {
            this.renderHierarchy(publicBlock, publics);
        }
    }

    // ── Toolbars ──────────────────────────────────────────────────────────────
    private renderBrowseToolbar(parent: HTMLElement) {
        const bar = parent.createDiv({ cls: 'docs-cms-tree-toolbar' });
        const structure = this.plugin.config.structure;
        const versioned = structure.layout.startsWith('versioned-');
        const multilang = structure.layout.endsWith('-multilang');

        if (versioned) {
            const versions = this.plugin.detectVersions();

            const newVersionBtn = bar.createEl('button', {
                text: '+',
                cls: 'docs-cms-tree-btn docs-cms-tree-btn-icon',
                attr: { title: 'Create new version' },
            });
            newVersionBtn.onclick = () => new NewVersionModal(this.plugin).open();

            const versionSel = bar.createEl('select', { cls: 'docs-cms-select' });
            for (const v of versions) versionSel.createEl('option', { value: v, text: v });
            if (versions.length === 0) versionSel.createEl('option', { value: '', text: '(no versions)' });
            versionSel.value = this.version;
            versionSel.onchange = () => {
                this.version = versionSel.value;
                this.refresh();
            };
        }

        if (multilang) {
            const langSel = bar.createEl('select', { cls: 'docs-cms-select' });
            for (const l of structure.languages) {
                langSel.createEl('option', { value: l, text: l });
            }
            langSel.value = this.language;
            langSel.onchange = () => {
                this.language = langSel.value;
                this.refresh();
            };
        }

        const newBtn = bar.createEl('button', { text: '+ Page', cls: 'docs-cms-tree-btn' });
        newBtn.onclick = () => {
            new NewPageModal(this.plugin, {
                version: versioned ? this.version : null,
                language: multilang ? this.language : null,
                bucket: structure.draftsBucket,
            }).open();
        };

        const refreshBtn = bar.createEl('button', { text: '↻', cls: 'docs-cms-tree-btn docs-cms-tree-btn-icon', attr: { title: 'Refresh' } });
        refreshBtn.onclick = () => this.refresh();

        // Commit / Source-control button
        if (this.gitAvailable) {
            const changed = this.gitFiles.length;
            const ahead = this.gitUpstream?.ahead ?? 0;
            const behind = this.gitUpstream?.behind ?? 0;
            const label = (() => {
                if (changed > 0) return `⎇ Commit · ${changed}`;
                if (ahead > 0 || behind > 0) return `⎇ Sync · ↑${ahead} ↓${behind}`;
                return `⎇ Git`;
            })();
            const commitBtn = bar.createEl('button', {
                text: label,
                cls: 'docs-cms-tree-btn docs-cms-tree-btn-commit',
                attr: { title: this.gitTooltip() },
            });
            commitBtn.onclick = () => {
                this.mode = 'commit';
                this.render();
            };
        }

        // Help — last item, sits at the far right.
        const helpBtn = bar.createEl('button', {
            text: '?',
            cls: 'docs-cms-tree-btn docs-cms-tree-btn-icon docs-cms-tree-btn-help',
            attr: { title: 'Plugin reference / help' },
        });
        helpBtn.onclick = () => new HelpModal(this.plugin).open();
    }

    private gitTooltip(): string {
        if (!this.gitUpstream) return '';
        const parts: string[] = [`branch: ${this.gitUpstream.branch}`];
        if (this.gitUpstream.upstream) parts.push(`upstream: ${this.gitUpstream.upstream}`);
        else parts.push('no upstream');
        if (this.gitUpstream.ahead) parts.push(`ahead: ${this.gitUpstream.ahead}`);
        if (this.gitUpstream.behind) parts.push(`behind: ${this.gitUpstream.behind}`);
        return parts.join(' · ');
    }

    // ── Browse mode rendering ─────────────────────────────────────────────────
    private collectPages(): PageNode[] {
        const out: PageNode[] = [];
        const versioned = !!this.plugin.config && this.plugin.config.structure.layout.startsWith('versioned-');
        const multilang = !!this.plugin.config && this.plugin.config.structure.layout.endsWith('-multilang');
        for (const f of this.app.vault.getMarkdownFiles()) {
            const p = parseDocPath(f.path);
            if (!p) continue;
            if (versioned && p.version !== this.version) continue;
            if (multilang && p.language !== this.language) continue;
            const fm = (this.app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as DocFrontmatter;
            const segments = p.relPath.split('/');
            const isIndex = (fm.doctype === 'index') || (segments.length === 1);
            const doctypeDir = segments.length >= 2 ? segments[0] : '';
            const chapterDir = segments.length >= 3 ? segments[1] : '';
            out.push({
                file: f,
                title: fm.title ?? f.basename,
                weight: typeof fm.weight === 'number' ? fm.weight : Number.POSITIVE_INFINITY,
                status: fm.status ?? '',
                bucket: p.bucket,
                chapterDir,
                doctypeDir,
                isIndex,
            });
        }
        return out;
    }

    private renderFlatList(parent: HTMLElement, pages: PageNode[]) {
        const ul = parent.createEl('ul', { cls: 'docs-cms-tree-list' });
        pages
            .sort((a, b) => a.file.path.localeCompare(b.file.path))
            .forEach((p) => this.renderPageItem(ul, p, false));
    }

    private renderHierarchy(parent: HTMLElement, pages: PageNode[]) {
        const indexes = pages.filter((p) => p.isIndex);
        const sectional = pages.filter((p) => !p.isIndex);

        if (indexes.length > 0) {
            const block = parent.createEl('details', { cls: 'docs-cms-tree-section' });
            block.setAttribute('open', '');
            block.createEl('summary', { text: `Index pages · ${indexes.length}` });
            const ul = block.createEl('ul', { cls: 'docs-cms-tree-list' });
            indexes
                .sort((a, b) => a.weight - b.weight || a.title.localeCompare(b.title))
                .forEach((p) => this.renderPageItem(ul, p, true));
        }

        const byDoctype = new Map<string, Map<string, PageNode[]>>();
        for (const p of sectional) {
            const dKey = p.doctypeDir || '(root)';
            const cKey = p.chapterDir || '(root)';
            if (!byDoctype.has(dKey)) byDoctype.set(dKey, new Map());
            const cMap = byDoctype.get(dKey)!;
            if (!cMap.has(cKey)) cMap.set(cKey, []);
            cMap.get(cKey)!.push(p);
        }

        const sortedDoctypeKeys = [...byDoctype.keys()].sort(compareDoctypes(this.weights));
        for (const doctypeDir of sortedDoctypeKeys) {
            const chapters = byDoctype.get(doctypeDir)!;
            const block = parent.createEl('details', { cls: 'docs-cms-tree-section' });
            block.setAttribute('open', '');
            block.createEl('summary', { text: `${doctypeDir} · ${countPages(chapters)}` });

            const sortedChapterKeys = [...chapters.keys()].sort(compareChapters(this.weights, doctypeDir));
            for (const chapterDir of sortedChapterKeys) {
                const list = chapters.get(chapterDir)!;
                const chBlock = block.createEl('details', { cls: 'docs-cms-tree-chapter' });
                chBlock.setAttribute('open', '');
                chBlock.createEl('summary', { text: `${chapterDir} · ${list.length}` });
                const ul = chBlock.createEl('ul', { cls: 'docs-cms-tree-list' });
                ul.dataset.chapterKey = `${doctypeDir}/${chapterDir}`;
                list
                    .sort((a, b) => a.weight - b.weight || a.title.localeCompare(b.title))
                    .forEach((p) => this.renderPageItem(ul, p, true));
            }
        }
    }

    private renderPageItem(ul: HTMLUListElement, page: PageNode, allowDnD: boolean) {
        const li = ul.createEl('li', { cls: 'docs-cms-tree-page' });

        // Git state stripe (left border): blue if uncommitted, green if clean.
        const gitFile = this.gitAvailable ? this.gitFileMap.get(page.file.path) : undefined;
        if (this.gitAvailable) {
            if (gitFile) {
                li.addClass('git-dirty');
                li.setAttribute('title', `git: ${gitFile.kind} — pending commit`);
            } else {
                li.addClass('git-clean');
            }
        }

        const weight = li.createEl('span', { cls: 'docs-cms-tree-weight' });
        weight.setText(Number.isFinite(page.weight) ? String(page.weight) : '∞');

        const link = li.createEl('a', { cls: 'docs-cms-tree-link', text: page.title });
        link.onclick = (e) => {
            e.preventDefault();
            this.app.workspace.getLeaf(false).openFile(page.file);
        };

        // Git-status letter badge (M/A/D/R/?) — same look as the commit panel.
        if (gitFile) {
            li.createEl('span', {
                cls: `docs-cms-commit-status status-${gitFile.kind}`,
                text: gitStatusLetter(gitFile),
                attr: { title: gitTooltipText(gitFile) },
            });
        }

        if (page.status && page.status !== 'published') {
            li.createEl('span', { cls: `docs-cms-tree-badge status-${page.status}`, text: page.status });
        }

        const menuBtn = li.createEl('button', { cls: 'docs-cms-tree-menu', text: '⋯' });
        menuBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            showPageMenu(this.plugin, page.file, e);
        };

        li.oncontextmenu = (e) => {
            e.preventDefault();
            showPageMenu(this.plugin, page.file, e);
        };

        if (allowDnD) {
            li.draggable = true;
            li.dataset.path = page.file.path;
            li.addEventListener('dragstart', (e) => {
                if (!e.dataTransfer) return;
                e.dataTransfer.setData(DRAG_MIME, page.file.path);
                e.dataTransfer.effectAllowed = 'move';
                li.addClass('docs-cms-tree-dragging');
            });
            li.addEventListener('dragend', () => li.removeClass('docs-cms-tree-dragging'));
            li.addEventListener('dragover', (e) => {
                if (!e.dataTransfer) return;
                if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                li.addClass('docs-cms-tree-drop-target');
            });
            li.addEventListener('dragleave', () => li.removeClass('docs-cms-tree-drop-target'));
            li.addEventListener('drop', (e) => {
                e.preventDefault();
                li.removeClass('docs-cms-tree-drop-target');
                const sourcePath = e.dataTransfer?.getData(DRAG_MIME);
                if (!sourcePath || sourcePath === page.file.path) return;
                this.handleDrop(sourcePath, page.file.path).catch((err) =>
                    new Notice(`Reorder failed: ${err}`),
                );
            });
        }
    }

    private async handleDrop(sourcePath: string, targetPath: string) {
        const srcFile = this.app.vault.getAbstractFileByPath(sourcePath);
        const tgtFile = this.app.vault.getAbstractFileByPath(targetPath);
        if (!(srcFile instanceof TFile) || !(tgtFile instanceof TFile)) return;

        const srcParsed = parseDocPath(sourcePath);
        const tgtParsed = parseDocPath(targetPath);
        if (!srcParsed || !tgtParsed) return;
        if (srcParsed.version !== tgtParsed.version || srcParsed.language !== tgtParsed.language || srcParsed.bucket !== tgtParsed.bucket) {
            new Notice('Cross-language / bucket DnD not supported — use the right-click menu.');
            return;
        }

        const srcSegs = srcParsed.relPath.split('/');
        const tgtSegs = tgtParsed.relPath.split('/');
        const srcChapter = srcSegs.slice(0, srcSegs.length - 1).join('/');
        const tgtChapter = tgtSegs.slice(0, tgtSegs.length - 1).join('/');
        if (srcChapter !== tgtChapter) {
            new Notice('Cross-chapter DnD not supported — use Rename / Move via the menu.');
            return;
        }

        const siblings: { file: TFile; weight: number }[] = [];
        const parts: string[] = [];
        if (tgtParsed.version) parts.push(tgtParsed.version);
        if (tgtParsed.language) parts.push(tgtParsed.language);
        parts.push(tgtParsed.bucket);
        if (tgtChapter) parts.push(tgtChapter);
        const prefix = parts.join('/') + '/';
        for (const f of this.app.vault.getMarkdownFiles()) {
            if (!f.path.startsWith(prefix)) continue;
            const rest = f.path.slice(prefix.length);
            if (rest.includes('/')) continue;
            const fm = (this.app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as DocFrontmatter;
            siblings.push({ file: f, weight: typeof fm.weight === 'number' ? fm.weight : Number.POSITIVE_INFINITY });
        }
        siblings.sort((a, b) => a.weight - b.weight || a.file.basename.localeCompare(b.file.basename));

        const filtered = siblings.map((s) => s.file).filter((f) => f.path !== sourcePath);
        const tgtIdx = filtered.findIndex((f) => f.path === targetPath);
        if (tgtIdx < 0) return;
        filtered.splice(tgtIdx, 0, srcFile);

        for (let i = 0; i < filtered.length; i++) {
            const newWeight = i + 1;
            await this.app.fileManager.processFrontMatter(filtered[i], (fm) => {
                (fm as Record<string, unknown>).weight = newWeight;
            });
        }
        new Notice(`Reordered ${filtered.length} pages in ${tgtChapter}`);
    }

    // ── Commit mode ───────────────────────────────────────────────────────────
    /**
     * A file is "staged" if its index column has a real change letter
     * (anything other than space or untracked-`?`). Untracked files always
     * land in Changes.
     */
    private isStaged(f: GitFile): boolean {
        return f.indexStatus !== ' ' && f.indexStatus !== '?';
    }

    /**
     * Build per-section entries from raw `git status` rows.
     *
     * A file with non-empty changes on BOTH the index column and the working
     * column (e.g. `MM` — staged a modification, then modified again) appears
     * twice — once in Staged with the index letter, once in Changes with the
     * working letter. Stage/unstage actions still reference the same path.
     */
    private buildEntries(): { staged: ChangeEntry[]; unstaged: ChangeEntry[] } {
        const staged: ChangeEntry[] = [];
        const unstaged: ChangeEntry[] = [];

        for (const f of this.gitFiles) {
            const idx = f.indexStatus;
            const work = f.workingStatus;

            // Untracked: only in Changes.
            if (idx === '?' && work === '?') {
                unstaged.push({ file: f, statusLetter: '?', kind: 'untracked' });
                continue;
            }

            if (idx !== ' ' && idx !== '?') {
                staged.push({ file: f, statusLetter: idx, kind: kindFromLetter(idx) });
            }
            if (work !== ' ' && work !== '?') {
                unstaged.push({ file: f, statusLetter: work, kind: kindFromLetter(work) });
            }
        }
        return { staged, unstaged };
    }

    private renderCommitMode(parent: HTMLElement) {
        parent.addClass('docs-cms-tree-commit');

        const bar = parent.createDiv({ cls: 'docs-cms-tree-toolbar docs-cms-commit-toolbar' });
        const cancel = bar.createEl('button', { text: '← Cancel', cls: 'docs-cms-tree-btn' });
        cancel.disabled = this.gitBusy;
        cancel.onclick = () => {
            this.mode = 'browse';
            this.commitMessage = '';
            this.render();
        };

        const refresh = bar.createEl('button', {
            text: '↻',
            cls: 'docs-cms-tree-btn',
            attr: { title: 'Refresh git status' },
        });
        refresh.disabled = this.gitBusy;
        refresh.onclick = () => this.refresh();

        const fetchBtn = bar.createEl('button', {
            text: 'Fetch',
            cls: 'docs-cms-tree-btn',
            attr: { title: 'git fetch --prune' },
        });
        fetchBtn.disabled = this.gitBusy;
        fetchBtn.onclick = () => this.runFetch();

        // Branch summary
        const summary = parent.createDiv({ cls: 'docs-cms-commit-summary' });
        if (this.gitUpstream) {
            summary.createEl('strong', { text: this.gitUpstream.branch });
            if (this.gitUpstream.upstream) {
                summary.createSpan({
                    cls: 'docs-cms-commit-upstream',
                    text: ` ↔ ${this.gitUpstream.upstream}`,
                });
            } else {
                summary.createSpan({ cls: 'docs-cms-commit-upstream', text: ' (no upstream)' });
            }
            const ah = summary.createSpan({ cls: 'docs-cms-commit-counts' });
            ah.setText(` · ↑${this.gitUpstream.ahead} ↓${this.gitUpstream.behind}`);
        }

        const { staged, unstaged } = this.buildEntries();
        const stagedPathsUnique = [...new Set(staged.map((e) => e.file.path))];
        const unstagedPathsUnique = [...new Set(unstaged.map((e) => e.file.path))];

        if (this.gitFiles.length === 0) {
            parent.createEl('p', {
                text: 'No local changes.',
                cls: 'docs-cms-tree-empty',
            });
        }

        // ── Staged section (top — what will be committed) ────────────────────
        if (staged.length > 0) {
            const stagedSection = parent.createDiv({ cls: 'docs-cms-commit-changes' });
            const stagedHeader = stagedSection.createDiv({ cls: 'docs-cms-commit-section-header' });
            stagedHeader.createEl('h4', { text: `Staged · ${staged.length}` });
            const unstageAll = stagedHeader.createEl('button', {
                text: 'Unstage all',
                cls: 'docs-cms-tree-btn',
                attr: { title: 'Move all staged back to Changes' },
            });
            unstageAll.disabled = this.gitBusy;
            unstageAll.onclick = () => this.runUnstage(stagedPathsUnique);

            this.renderFileList(stagedSection, staged, 'unstage');
        }

        // ── Changes section (bottom — not yet staged) ────────────────────────
        if (unstaged.length > 0) {
            const changesSection = parent.createDiv({ cls: 'docs-cms-commit-changes' });
            const changesHeader = changesSection.createDiv({ cls: 'docs-cms-commit-section-header' });
            changesHeader.createEl('h4', { text: `Changes · ${unstaged.length}` });
            const stageAll = changesHeader.createEl('button', {
                text: 'Stage all',
                cls: 'docs-cms-tree-btn',
                attr: { title: 'Move everything to Staged' },
            });
            stageAll.disabled = this.gitBusy;
            stageAll.onclick = () => this.runStage(unstagedPathsUnique);

            this.renderFileList(changesSection, unstaged, 'stage');
        }

        // ── Commit message ───────────────────────────────────────────────────
        const msgBlock = parent.createDiv({ cls: 'docs-cms-commit-message-block' });
        msgBlock.createEl('label', { text: 'Message' });
        const textarea = msgBlock.createEl('textarea', {
            cls: 'docs-cms-commit-message',
            attr: { placeholder: 'Commit message…', rows: '3' },
        });
        textarea.value = this.commitMessage;
        textarea.disabled = this.gitBusy;
        textarea.oninput = () => {
            this.commitMessage = textarea.value;
            commitBtn.disabled = this.gitBusy || !this.commitMessage.trim() || stagedPathsUnique.length === 0;
        };
        setTimeout(() => textarea.focus(), 0);

        // ── Action buttons ───────────────────────────────────────────────────
        const actions = parent.createDiv({ cls: 'docs-cms-commit-actions' });
        const commitBtn = actions.createEl('button', {
            text: stagedPathsUnique.length > 0 ? `Commit · ${stagedPathsUnique.length}` : 'Commit',
            cls: 'docs-cms-tree-btn mod-cta',
            attr: { title: stagedPathsUnique.length === 0 ? 'Nothing staged — use + to stage files first' : '' },
        });
        commitBtn.disabled = this.gitBusy || !this.commitMessage.trim() || stagedPathsUnique.length === 0;
        commitBtn.onclick = () => this.runCommit();

        const ahead = this.gitUpstream?.ahead ?? 0;
        const behind = this.gitUpstream?.behind ?? 0;
        if (ahead > 0 || behind > 0) {
            const syncBtn = actions.createEl('button', {
                text: behind > 0 ? `Sync ↓${behind} ↑${ahead}` : `Sync ↑${ahead}`,
                cls: 'docs-cms-tree-btn',
                attr: { title: behind > 0 ? 'Pull then push' : 'Push' },
            });
            syncBtn.disabled = this.gitBusy;
            syncBtn.onclick = () => this.runSync();
        }
    }

    /**
     * Render a flat list of file entries. `action` controls whether each row
     * shows a `+` (stage) or `−` (unstage) button on the right.
     *
     * Files with both index and working-tree changes (e.g. `MM`) appear in two
     * entries — the rendered status letter reflects the relevant column for
     * each section.
     */
    private renderFileList(container: HTMLElement, entries: ChangeEntry[], action: 'stage' | 'unstage') {
        const ul = container.createEl('ul', { cls: 'docs-cms-commit-list' });
        for (const entry of entries) {
            const li = ul.createEl('li', { cls: 'docs-cms-commit-file' });

            li.createSpan({
                cls: `docs-cms-commit-status status-${entry.kind}`,
                text: entry.statusLetter,
            });

            const link = li.createEl('a', {
                cls: 'docs-cms-commit-link',
                text: shortenPath(entry.file.path),
                attr: { title: entry.file.path },
            });
            link.onclick = (e) => {
                e.preventDefault();
                const af = this.app.vault.getAbstractFileByPath(entry.file.path);
                if (af instanceof TFile) this.app.workspace.getLeaf(false).openFile(af);
            };

            const btn = li.createEl('button', {
                cls: 'docs-cms-stage-btn',
                text: action === 'stage' ? '+' : '−',
                attr: { title: action === 'stage' ? 'Stage this file' : 'Unstage this file' },
            });
            btn.disabled = this.gitBusy;
            btn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (action === 'stage') this.runStage([entry.file.path]);
                else this.runUnstage([entry.file.path]);
            };
        }
    }

    private async runStage(paths: string[]) {
        const cwd = this.getRepoCwd();
        if (!cwd || paths.length === 0) return;
        this.gitBusy = true;
        this.render();
        try {
            await stagePaths(cwd, paths);
        } catch (e) {
            new Notice(`Stage failed: ${e}`);
        } finally {
            this.gitBusy = false;
            await this.refresh();
        }
    }

    private async runUnstage(paths: string[]) {
        const cwd = this.getRepoCwd();
        if (!cwd || paths.length === 0) return;
        this.gitBusy = true;
        this.render();
        try {
            await unstagePaths(cwd, paths);
        } catch (e) {
            new Notice(`Unstage failed: ${e}`);
        } finally {
            this.gitBusy = false;
            await this.refresh();
        }
    }

    private async runFetch() {
        const cwd = this.getRepoCwd();
        if (!cwd) return;
        this.gitBusy = true;
        this.render();
        try {
            await gitFetch(cwd);
            new Notice('Fetched');
        } catch (e) {
            new Notice(`Fetch failed: ${e}`);
        } finally {
            this.gitBusy = false;
            await this.refresh();
        }
    }

    private async runCommit() {
        const cwd = this.getRepoCwd();
        if (!cwd) return;
        const message = this.commitMessage.trim();
        if (!message) {
            new Notice('Commit message required');
            return;
        }
        const stagedFiles = this.gitFiles.filter((f) => this.isStaged(f));
        if (stagedFiles.length === 0) {
            new Notice('Nothing staged — use + to stage files first');
            return;
        }

        this.gitBusy = true;
        this.render();
        try {
            // No auto-stage — commit only what user explicitly staged.
            await gitCommit(cwd, message);
            new Notice(`Committed: ${shortMessage(message)}`);
            this.commitMessage = '';
        } catch (e) {
            new Notice(`Commit failed: ${e}`);
        } finally {
            this.gitBusy = false;
            await this.refresh();
        }
    }

    private async runSync() {
        const cwd = this.getRepoCwd();
        if (!cwd) return;

        const ahead = this.gitUpstream?.ahead ?? 0;
        const behind = this.gitUpstream?.behind ?? 0;

        const proceed = await this.confirmPush(ahead, behind);
        if (!proceed) return;

        this.gitBusy = true;
        this.render();
        try {
            if (behind > 0 && this.plugin.settings.gitPullBeforePush) {
                await gitPull(cwd);
                new Notice(`Pulled (rebase)`);
            }
            const out = await gitPush(cwd);
            new Notice(`Pushed${out ? `: ${shortMessage(out)}` : ''}`);
        } catch (e) {
            new Notice(`Push failed: ${e}`);
        } finally {
            this.gitBusy = false;
            await this.refresh();
        }
    }

    private confirmPush(ahead: number, behind: number): Promise<boolean> {
        if (!this.plugin.settings.gitPushRequiresConfirmation) return Promise.resolve(true);
        return new Promise((resolve) => {
            const branch = this.gitUpstream?.branch ?? '?';
            const upstream = this.gitUpstream?.upstream ?? `origin/${branch}`;
            new ConfirmPushModal(this.app, branch, upstream, ahead, behind, resolve).open();
        });
    }
}

class ConfirmPushModal extends Modal {
    constructor(
        app: App,
        private branch: string,
        private upstream: string,
        private ahead: number,
        private behind: number,
        private resolve: (ok: boolean) => void,
    ) {
        super(app);
    }

    private resolved = false;

    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText('Sync (push)');
        contentEl.createEl('p', {
            text: `Push ${this.ahead} commit${this.ahead === 1 ? '' : 's'} from "${this.branch}" to "${this.upstream}"?`,
        });
        if (this.behind > 0) {
            contentEl.createEl('p', {
                text: `Upstream is ${this.behind} commit${this.behind === 1 ? '' : 's'} ahead. Push will be rejected unless you pull/rebase first.`,
                cls: 'docs-cms-warning',
            });
        }
        const buttons = contentEl.createDiv({ cls: 'docs-cms-modal-buttons' });
        const ok = buttons.createEl('button', { text: 'Push', cls: 'mod-cta' });
        ok.onclick = () => {
            this.resolved = true;
            this.resolve(true);
            this.close();
        };
        const cancel = buttons.createEl('button', { text: 'Cancel' });
        cancel.onclick = () => this.close();
    }

    onClose() {
        if (!this.resolved) this.resolve(false);
        this.contentEl.empty();
    }
}

function countPages(byChapter: Map<string, PageNode[]>): number {
    let n = 0;
    for (const list of byChapter.values()) n += list.length;
    return n;
}

function kindLabel(k: GitFile['kind']): string {
    switch (k) {
        case 'modified': return 'Modified';
        case 'added': return 'Added';
        case 'deleted': return 'Deleted';
        case 'renamed': return 'Renamed';
        case 'untracked': return 'Untracked';
        default: return 'Other';
    }
}

/**
 * Map a single status letter from `git status --porcelain` (M, A, D, R, C, U)
 * onto our GitFile kind taxonomy. Used when splitting MM-style files into two
 * entries with different displayed letters.
 */
function kindFromLetter(letter: string): GitFile['kind'] {
    switch (letter) {
        case 'M': return 'modified';
        case 'A': return 'added';
        case 'D': return 'deleted';
        case 'R':
        case 'C': return 'renamed';
        case '?': return 'untracked';
        default: return 'other';
    }
}

/**
 * One-letter summary letter to show in the tree row badge.
 *
 * Files with both staged and working changes (e.g. `MM`, `AM`) get the more
 * structurally significant letter so the badge stays useful at-a-glance:
 *   ?? → ?
 *   AM → A   (it's a new file, the M is just staging detail)
 *   MD → D   (deleted wins — that's the bigger event)
 *   MM → M
 */
function gitStatusLetter(f: GitFile): string {
    switch (f.kind) {
        case 'untracked': return '?';
        case 'added': return 'A';
        case 'deleted': return 'D';
        case 'renamed': return 'R';
        case 'modified': return 'M';
        default: return '•';
    }
}

function gitTooltipText(f: GitFile): string {
    const sides: string[] = [];
    if (f.indexStatus !== ' ' && f.indexStatus !== '?') sides.push(`staged ${f.indexStatus}`);
    if (f.workingStatus !== ' ' && f.workingStatus !== '?') sides.push(`working ${f.workingStatus}`);
    if (f.kind === 'untracked') sides.push('untracked');
    return sides.length ? `git: ${sides.join(', ')}` : `git: ${f.kind}`;
}

function shortenPath(p: string, max = 60): string {
    if (p.length <= max) return p;
    return '…' + p.slice(p.length - max + 1);
}

function shortMessage(s: string, max = 80): string {
    const first = s.split('\n')[0].trim();
    return first.length > max ? first.slice(0, max - 1) + '…' : first;
}
