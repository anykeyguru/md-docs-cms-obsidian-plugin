import { ItemView, TFile, WorkspaceLeaf, Notice } from 'obsidian';
import { runHealthCheck } from './health-check';
import { BrokenRef } from './types';
import type DocsCmsPlugin from './main';

export const HEALTH_VIEW_TYPE = 'docs-cms-health';

export class HealthView extends ItemView {
    private plugin: DocsCmsPlugin;
    private results: BrokenRef[] = [];
    private loading = false;

    constructor(leaf: WorkspaceLeaf, plugin: DocsCmsPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return HEALTH_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'Docs CMS health';
    }

    getIcon(): string {
        return 'shield-check';
    }

    async onOpen() {
        await this.refresh();
    }

    async refresh() {
        if (this.loading) return;
        this.loading = true;
        try {
            this.results = await runHealthCheck(this.app, {
                attachmentsDir: this.plugin.settings.attachmentsDir,
                includeDrafts: this.plugin.settings.healthIncludeDrafts,
                skipPathPatterns: this.plugin.settings.healthSkipPathPatterns,
            });
            this.render();
        } finally {
            this.loading = false;
        }
    }

    private render() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('docs-cms-health');

        const header = contentEl.createDiv({ cls: 'docs-cms-health-header' });
        header.createEl('h3', {
            text: this.results.length === 0
                ? 'Docs CMS health'
                : `Docs CMS health — ${this.results.length} issue${this.results.length === 1 ? '' : 's'}`,
        });
        const refresh = header.createEl('button', { text: 'Refresh' });
        refresh.onclick = () => {
            this.refresh().catch((e) => new Notice(`Health refresh failed: ${e}`));
        };

        if (this.results.length === 0) {
            contentEl.createEl('p', {
                text: '✓ All wiki-links and embeds resolve.',
                cls: 'docs-cms-health-empty',
            });
            return;
        }

        const byFile = new Map<string, BrokenRef[]>();
        for (const r of this.results) {
            let list = byFile.get(r.file);
            if (!list) {
                list = [];
                byFile.set(r.file, list);
            }
            list.push(r);
        }

        for (const [path, refs] of byFile) {
            const fileBlock = contentEl.createDiv({ cls: 'docs-cms-health-file' });
            const heading = fileBlock.createEl('h4');
            heading.createEl('a', {
                text: path,
                cls: 'docs-cms-health-link',
            }).onclick = (e) => {
                e.preventDefault();
                this.openFile(path);
            };

            const list = fileBlock.createEl('ul', { cls: 'docs-cms-health-list' });
            for (const r of refs) {
                const item = list.createEl('li');
                item.createSpan({ text: `[${r.kind}] `, cls: 'docs-cms-health-kind' });
                const link = item.createEl('a', {
                    text: `line ${r.line}`,
                    cls: 'docs-cms-health-link',
                });
                link.onclick = (e) => {
                    e.preventDefault();
                    this.openFile(r.file, r.line);
                };
                item.createSpan({ text: ` → `, cls: 'docs-cms-health-arrow' });
                item.createSpan({ text: r.target, cls: 'docs-cms-health-target' });
            }
        }
    }

    private openFile(path: string, line?: number) {
        const af = this.app.vault.getAbstractFileByPath(path);
        if (!(af instanceof TFile)) {
            new Notice(`File not found: ${path}`);
            return;
        }
        const leaf = this.app.workspace.getLeaf(false);
        leaf.openFile(af, line !== undefined
            ? { eState: { line: line - 1, ch: 0 } }
            : undefined);
    }
}
