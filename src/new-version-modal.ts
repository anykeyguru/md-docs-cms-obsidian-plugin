import { Modal, Notice, Setting, TFile, normalizePath } from 'obsidian';
import { hasLanguages } from './cms-config';
import { bucketPath, parseDocPath } from './paths';
import { ensureFolder } from './promote';
import type DocsCmsPlugin from './main';

type CopyMode = 'empty' | 'fork-public' | 'fork-all';

const COPY_MODE_LABEL: Record<CopyMode, string> = {
    'empty': 'Empty skeleton (just folders)',
    'fork-public': 'Fork published pages (drafts stay empty)',
    'fork-all': 'Fork all files (public + drafts)',
};

/**
 * Create a new version directory and (optionally) seed it with files from an
 * existing version. Available only on `versioned-*` layouts.
 */
export class NewVersionModal extends Modal {
    private plugin: DocsCmsPlugin;
    private newVersion: string;
    private sourceVersion: string;
    private copyMode: CopyMode = 'empty';
    private bumpAppversion: boolean = true;

    constructor(plugin: DocsCmsPlugin) {
        super(plugin.app);
        this.plugin = plugin;

        const versions = plugin.detectVersions();
        this.sourceVersion = versions[0] ?? '';
        this.newVersion = this.sourceVersion ? bumpMinorVersion(this.sourceVersion) : 'v1.0.0';
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText('New version');

        contentEl.createEl('p', {
            text: 'Creates a new version directory with the standard layout (language → public/drafts). Optionally seeds it with files from an existing version.',
            cls: 'setting-item-description',
        });

        const versions = this.plugin.detectVersions();

        new Setting(contentEl)
            .setName('New version name')
            .setDesc(`Must match pattern: ${this.plugin.config.structure.versionPattern}`)
            .addText((t) => {
                t.setValue(this.newVersion).onChange((v) => (this.newVersion = v.trim()));
                t.inputEl.style.fontFamily = 'var(--font-monospace)';
            });

        if (versions.length > 0) {
            new Setting(contentEl)
                .setName('Source version (optional)')
                .setDesc('Pick an existing version to seed structure / files from. weights.json is copied automatically when a source is selected.')
                .addDropdown((dd) => {
                    dd.addOption('', '(none — empty)');
                    for (const v of versions) dd.addOption(v, v);
                    dd.setValue(this.sourceVersion).onChange((v) => (this.sourceVersion = v));
                });

            new Setting(contentEl).setName('Copy mode').addDropdown((dd) => {
                for (const k of Object.keys(COPY_MODE_LABEL) as CopyMode[]) {
                    dd.addOption(k, COPY_MODE_LABEL[k]);
                }
                dd.setValue(this.copyMode).onChange((v) => (this.copyMode = v as CopyMode));
            });

            new Setting(contentEl)
                .setName('Bump appversion in forked files')
                .setDesc('When forking, set frontmatter.appversion to the new version (without the leading "v"). Skip if you want to keep historical values.')
                .addToggle((tg) => tg.setValue(this.bumpAppversion).onChange((v) => (this.bumpAppversion = v)));
        }

        const buttons = contentEl.createDiv({ cls: 'docs-cms-modal-buttons' });
        const ok = buttons.createEl('button', { text: 'Create version', cls: 'mod-cta' });
        ok.onclick = () => this.run().catch((e) => new Notice(`Create failed: ${e}`));
        const cancel = buttons.createEl('button', { text: 'Cancel' });
        cancel.onclick = () => this.close();
    }

    onClose() {
        this.contentEl.empty();
    }

    private async run() {
        if (!this.newVersion) {
            new Notice('Version name is required');
            return;
        }
        const pattern = new RegExp(`^${this.plugin.config.structure.versionPattern}$`);
        if (!pattern.test(this.newVersion)) {
            new Notice(`"${this.newVersion}" does not match pattern ${this.plugin.config.structure.versionPattern}`);
            return;
        }
        const existing = this.app.vault.getAbstractFileByPath(this.newVersion);
        if (existing) {
            new Notice(`Version ${this.newVersion} already exists`);
            return;
        }

        const structure = this.plugin.config.structure;
        const langs = hasLanguages(structure) ? structure.languages : [''];
        const buckets = [structure.draftsBucket, structure.publicBucket];

        // ── 1. Create directory skeleton: {newVersion}/{lang?}/{bucket}/ ──────
        let createdFolders = 0;
        for (const l of langs) {
            for (const b of buckets) {
                const parts = [this.newVersion, l, b].filter(Boolean);
                const dir = parts.join('/');
                await this.app.vault.createFolder(dir);
                createdFolders++;
            }
        }

        // ── 2. Optionally fork files from source ─────────────────────────────
        let forkedFiles = 0;
        if (this.copyMode !== 'empty' && this.sourceVersion) {
            const newAppversion = this.newVersion.replace(/^v/, '');
            for (const f of this.app.vault.getMarkdownFiles()) {
                const p = parseDocPath(f.path);
                if (!p) continue;
                if (p.version !== this.sourceVersion) continue;
                if (this.copyMode === 'fork-public' && !p.isPublic) continue;

                const newPath = normalizePath(bucketPath(this.newVersion, p.language, p.bucket, p.relPath));
                if (this.app.vault.getAbstractFileByPath(newPath)) continue;
                await ensureFolder(this.app, newPath);
                const text = await this.app.vault.read(f);
                const created = await this.app.vault.create(newPath, text);

                if (this.bumpAppversion) {
                    await this.app.fileManager.processFrontMatter(created, (fm) => {
                        (fm as Record<string, unknown>).appversion = newAppversion;
                    });
                }
                forkedFiles++;
            }
        }

        // ── 3. Copy weights.json from source if a source was specified ───────
        let copiedWeights = false;
        if (this.sourceVersion) {
            const src = this.app.vault.getAbstractFileByPath(`${this.sourceVersion}/weights.json`);
            const dst = `${this.newVersion}/weights.json`;
            if (src instanceof TFile && !this.app.vault.getAbstractFileByPath(dst)) {
                await this.app.vault.create(dst, await this.app.vault.read(src));
                copiedWeights = true;
            }
        }

        const summary: string[] = [
            `${createdFolders} folder${createdFolders === 1 ? '' : 's'}`,
        ];
        if (forkedFiles > 0) summary.push(`${forkedFiles} file${forkedFiles === 1 ? '' : 's'} forked`);
        if (copiedWeights) summary.push('weights.json copied');
        new Notice(`Created ${this.newVersion}: ${summary.join(', ')}`);

        await this.plugin.applyConfig(); // refresh open views to pick up the new version
        this.close();
    }
}

/**
 * Suggest the next version. Defaults to bumping minor (`v1.0.0` → `v1.1.0`)
 * which is the most common docs versioning cadence — features added,
 * breaking changes mostly handled by major bumps.
 */
function bumpMinorVersion(v: string): string {
    const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(v);
    if (!m) return v;
    return `v${m[1]}.${parseInt(m[2], 10) + 1}.0`;
}
