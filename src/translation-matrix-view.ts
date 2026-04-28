import { ItemView, Notice, TFile, WorkspaceLeaf, normalizePath } from 'obsidian';
import { Bucket, Language, bucketPath, parseDocPath } from './paths';
import { hasLanguages } from './cms-config';
import { DocFrontmatter } from './types';
import { ensureFolder } from './promote';
import type DocsCmsPlugin from './main';

export const TRANSLATION_MATRIX_VIEW_TYPE = 'docs-cms-translation-matrix';

interface CellState {
    file?: TFile;
    bucket?: Bucket;
    title?: string;
    translationStatus?: string; // fresh | stale | manual_override
}

interface MatrixRow {
    relPath: string;
    cells: Record<string, CellState>;
}

/**
 * Cross-language coverage view: rows are unique `relPath` values within a
 * version, columns are languages, cell content shows whether the page exists
 * in that language and in which bucket.
 *
 * Click an existing cell → open the file. Click a missing cell → create a draft
 * by duplicating from any other language that has the page.
 */
export class TranslationMatrixView extends ItemView {
    private plugin: DocsCmsPlugin;
    private version: string;

    constructor(leaf: WorkspaceLeaf, plugin: DocsCmsPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.version = plugin.detectVersions()[0] ?? 'v1.0.0';
    }

    getViewType(): string {
        return TRANSLATION_MATRIX_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'Docs CMS — translations';
    }

    getIcon(): string {
        return 'languages';
    }

    async onOpen() {
        this.render();
        this.registerEvent(this.app.vault.on('create', () => this.render()));
        this.registerEvent(this.app.vault.on('delete', () => this.render()));
        this.registerEvent(this.app.vault.on('rename', () => this.render()));
        this.registerEvent(this.app.metadataCache.on('changed', () => this.render()));
    }

    private render() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('docs-cms-matrix');

        const structure = this.plugin.config.structure;
        const langs = structure.languages;
        const publicBucket = structure.publicBucket;
        const draftsBucket = structure.draftsBucket;

        if (!hasLanguages(structure)) {
            contentEl.createEl('p', {
                text: 'Translation matrix is only meaningful for multi-language layouts. Your current layout has no language dimension.',
                cls: 'docs-cms-tree-empty',
            });
            return;
        }

        // Toolbar
        const bar = contentEl.createDiv({ cls: 'docs-cms-tree-toolbar' });
        const versionSel = bar.createEl('select', { cls: 'docs-cms-select' });
        for (const v of this.plugin.detectVersions()) versionSel.createEl('option', { value: v, text: v });
        versionSel.value = this.version;
        versionSel.onchange = () => {
            this.version = versionSel.value;
            this.render();
        };
        const refresh = bar.createEl('button', { text: '↻', cls: 'docs-cms-tree-btn', attr: { title: 'Refresh' } });
        refresh.onclick = () => this.render();

        const rows = this.collectRows(langs);
        if (rows.length === 0) {
            contentEl.createEl('p', { text: `No pages found in ${this.version}.`, cls: 'docs-cms-tree-empty' });
            return;
        }

        // Summary
        const summary = contentEl.createDiv({ cls: 'docs-cms-matrix-summary' });
        for (const lang of langs) {
            const total = rows.length;
            const present = rows.filter((r) => r.cells[lang]?.file).length;
            const published = rows.filter((r) => r.cells[lang]?.bucket === publicBucket).length;
            const draft = rows.filter((r) => r.cells[lang]?.bucket === draftsBucket).length;
            const pct = Math.round((present / total) * 100);
            const item = summary.createDiv({ cls: 'docs-cms-matrix-summary-lang' });
            item.createSpan({ cls: 'docs-cms-matrix-summary-label', text: lang.toUpperCase() });
            item.createSpan({
                text: ` ${present}/${total} (${pct}%)`,
                cls: 'docs-cms-matrix-summary-count',
            });
            item.createSpan({
                text: ` · ${publicBucket} ${published} · ${draftsBucket} ${draft}`,
                cls: 'docs-cms-matrix-summary-detail',
            });
        }

        // Table
        const table = contentEl.createEl('table', { cls: 'docs-cms-matrix-table' });
        const thead = table.createEl('thead');
        const headRow = thead.createEl('tr');
        headRow.createEl('th', { text: 'Page' });
        for (const l of langs) headRow.createEl('th', { text: l.toUpperCase() });

        const tbody = table.createEl('tbody');
        for (const row of rows) {
            const tr = tbody.createEl('tr');
            const pathCell = tr.createEl('td', { cls: 'docs-cms-matrix-path' });
            pathCell.setText(row.relPath);

            for (const lang of langs) {
                const td = tr.createEl('td', { cls: 'docs-cms-matrix-cell' });
                this.renderCell(td, row, lang, publicBucket);
            }
        }
    }

    private renderCell(td: HTMLTableCellElement, row: MatrixRow, lang: Language, publicBucket: string) {
        const cell = row.cells[lang] ?? {};
        if (!cell.file) {
            td.addClass('cell-missing');
            const btn = td.createEl('button', {
                cls: 'docs-cms-matrix-create',
                text: '+',
                attr: { title: `Create draft in ${lang}` },
            });
            btn.onclick = () => this.createMissing(row, lang).catch((e) => new Notice(`Create failed: ${e}`));
            return;
        }

        td.addClass(cell.bucket === publicBucket ? 'cell-public' : 'cell-draft');
        const link = td.createEl('a', {
            cls: 'docs-cms-matrix-link',
            text: cell.bucket === publicBucket ? '✓' : '⏳',
        });
        link.title = `${cell.bucket}: ${cell.title ?? row.relPath}${cell.translationStatus ? ` (${cell.translationStatus})` : ''}`;
        link.onclick = (e) => {
            e.preventDefault();
            if (cell.file) this.app.workspace.getLeaf(false).openFile(cell.file);
        };
        if (cell.translationStatus === 'stale') {
            td.createSpan({ cls: 'docs-cms-matrix-stale', text: ' ⚠', attr: { title: 'translation_status: stale' } });
        }
    }

    /** Build rows: union of unique relPath values across all languages of the version. */
    private collectRows(langs: string[]): MatrixRow[] {
        const map = new Map<string, MatrixRow>();
        const versioned = this.plugin.config.structure.layout.startsWith('versioned-');
        for (const f of this.app.vault.getMarkdownFiles()) {
            const p = parseDocPath(f.path);
            if (!p) continue;
            if (versioned && p.version !== this.version) continue;
            if (!p.language) continue;

            let row = map.get(p.relPath);
            if (!row) {
                const cells: Record<string, CellState> = {};
                for (const l of langs) cells[l] = {};
                row = { relPath: p.relPath, cells };
                map.set(p.relPath, row);
            }
            const fm = (this.app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as DocFrontmatter & {
                translation_status?: string;
            };
            row.cells[p.language] = {
                file: f,
                bucket: p.bucket,
                title: fm.title,
                translationStatus: fm.translation_status,
            };
        }
        return [...map.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
    }

    /**
     * Create a draft in the target language using any existing-language version
     * as the source. Frontmatter is patched with translation tracking fields.
     */
    private async createMissing(row: MatrixRow, targetLang: Language) {
        const order = this.plugin.config.structure.languages;
        const sourceLang = order.find((l) => row.cells[l]?.file && l !== targetLang);
        if (!sourceLang) {
            new Notice(`No source available to copy from`);
            return;
        }
        const src = row.cells[sourceLang].file!;
        const draftsBucket = this.plugin.config.structure.draftsBucket;
        const targetPath = normalizePath(bucketPath(this.version, targetLang, draftsBucket, row.relPath));
        const existing = this.app.vault.getAbstractFileByPath(targetPath);
        if (existing) {
            new Notice(`Already exists: ${targetPath}`);
            return;
        }
        await ensureFolder(this.app, targetPath);
        const text = await this.app.vault.read(src);
        const created = await this.app.vault.create(targetPath, text);
        await this.app.fileManager.processFrontMatter(created, (fm) => {
            (fm as Record<string, unknown>).status = 'draft';
            (fm as Record<string, unknown>).source_lang = sourceLang;
            (fm as Record<string, unknown>).source_path = src.path;
            (fm as Record<string, unknown>).translation_status = 'stale';
        });
        new Notice(`Created ${targetPath} from ${sourceLang}`);
        this.app.workspace.getLeaf(false).openFile(created);
    }
}
