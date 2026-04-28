import { App, Modal, Notice, Setting, TFolder, normalizePath } from 'obsidian';
import { Bucket, Language, bucketPath, isLayoutMultilang, isLayoutVersioned } from './paths';
import { ensureFolder } from './promote';
import { ensureChapterWeight, ensureDoctypeWeight } from './weights';
import type DocsCmsPlugin from './main';

export class NewPageModal extends Modal {
    private plugin: DocsCmsPlugin;

    private version: string | null;
    private language: string | null;
    private bucket: string;
    private doctype: string;
    private chapterDir: string = '';
    private filename: string = '';
    private title: string = '';
    private weight: number = 1;

    constructor(plugin: DocsCmsPlugin, defaults?: {
        version?: string | null;
        language?: string | null;
        bucket?: string;
        doctype?: string;
        chapterDir?: string;
    }) {
        super(plugin.app);
        this.plugin = plugin;
        const { structure } = plugin.config;
        this.version = defaults?.version ?? (isLayoutVersioned() ? plugin.detectVersions()[0] ?? null : null);
        this.language = defaults?.language ?? (isLayoutMultilang() ? plugin.settings.defaultLanguage : null);
        this.bucket = defaults?.bucket ?? structure.draftsBucket;
        this.doctype = defaults?.doctype ?? (structure.doctypes[0] ?? 'learn');
        if (defaults?.chapterDir) this.chapterDir = defaults.chapterDir;
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText('New page');

        const structure = this.plugin.config.structure;
        const versions = this.plugin.detectVersions();

        if (isLayoutVersioned()) {
            new Setting(contentEl).setName('Version').addDropdown((dd) => {
                for (const v of versions) dd.addOption(v, v);
                if (versions.length === 0) dd.addOption('', '(no versions)');
                dd.setValue(this.version ?? '');
                dd.onChange((v) => (this.version = v || null));
            });
        }

        if (isLayoutMultilang()) {
            new Setting(contentEl).setName('Language').addDropdown((dd) => {
                for (const l of structure.languages) dd.addOption(l, l);
                dd.setValue(this.language ?? structure.languages[0] ?? '');
                dd.onChange((v) => (this.language = v || null));
            });
        }

        new Setting(contentEl).setName('Bucket').addDropdown((dd) => {
            for (const b of structure.buckets) dd.addOption(b, b);
            dd.setValue(this.bucket);
            dd.onChange((v) => (this.bucket = v));
        });

        new Setting(contentEl).setName('Doctype').addDropdown((dd) => {
            for (const d of structure.doctypes) dd.addOption(d, d);
            dd.setValue(this.doctype);
            dd.onChange((v) => (this.doctype = v));
        });

        new Setting(contentEl)
            .setName('Chapter folder')
            .setDesc('Path under {doctype}/, e.g. "01-proxy" or "setup". Leave blank for root index pages.')
            .addText((t) => {
                t.setValue(this.chapterDir).onChange((v) => (this.chapterDir = v.trim()));
            });

        new Setting(contentEl)
            .setName('Filename (without extension)')
            .setDesc('Convention: numeric prefix + slug, e.g. "03-components".')
            .addText((t) => {
                t.setValue(this.filename).onChange((v) => (this.filename = v.trim()));
            });

        new Setting(contentEl).setName('Title').addText((t) => {
            t.setValue(this.title).onChange((v) => (this.title = v));
        });

        new Setting(contentEl).setName('Weight').addText((t) => {
            t.setValue(String(this.weight)).onChange((v) => {
                const n = Number(v);
                if (Number.isFinite(n)) this.weight = n;
            });
        });

        const buttons = contentEl.createDiv({ cls: 'docs-cms-modal-buttons' });
        const ok = buttons.createEl('button', { text: 'Create', cls: 'mod-cta' });
        ok.onclick = () => this.create().catch((e) => new Notice(`Create failed: ${e}`));
        const cancel = buttons.createEl('button', { text: 'Cancel' });
        cancel.onclick = () => this.close();
    }

    onClose() {
        this.contentEl.empty();
    }

    private async create() {
        if (!this.filename) {
            new Notice('Filename is required');
            return;
        }
        if (!this.title) {
            new Notice('Title is required');
            return;
        }
        if (isLayoutVersioned() && !this.version) {
            new Notice('Version is required for the configured layout');
            return;
        }
        if (isLayoutMultilang() && !this.language) {
            new Notice('Language is required for the configured layout');
            return;
        }

        const structure = this.plugin.config.structure;
        const doctypeFolder = this.findDoctypeFolder();

        const relPath = [doctypeFolder, this.chapterDir, `${this.filename}.md`]
            .filter(Boolean)
            .join('/');
        const targetPath = normalizePath(bucketPath(this.version, this.language, this.bucket, relPath));

        const existing = this.app.vault.getAbstractFileByPath(targetPath);
        if (existing) {
            new Notice(`Target already exists: ${targetPath}`);
            return;
        }

        await ensureFolder(this.app, targetPath);

        const today = new Date().toISOString().split('T')[0];
        const chapterSlug = this.chapterDir ? this.chapterDir.replace(/^\d+-/, '') : 'index';

        const frontmatter: Record<string, unknown> = {
            doctype: this.doctype,
            chapter: chapterSlug,
            weight: this.weight,
            title: this.title,
            appversion: this.plugin.settings.defaultAppversion,
            date: today,
            updated: today,
            author: this.plugin.settings.defaultAuthor,
            status: this.bucket === structure.draftsBucket ? 'draft' : 'published',
            ...this.plugin.config.frontmatter.defaults,
        };

        const yaml = renderYamlFrontmatter(frontmatter);
        const body = `${yaml}\n## ${this.title}\n\nWrite content here.\n`;

        const created = await this.app.vault.create(targetPath, body);

        // Patch weights.json so the new doctype/chapter sorts predictably on the site.
        // Only meaningful for versioned layouts that use weights.json.
        if (this.doctype !== 'index' && isLayoutVersioned() && this.version) {
            try {
                const addedDoctype = await ensureDoctypeWeight(this.app, this.version, doctypeFolder);
                if (addedDoctype) {
                    new Notice(`weights.json: added doctype "${doctypeFolder.replace(/^\d+-/, '')}"`);
                }
                if (this.chapterDir) {
                    const addedChapter = await ensureChapterWeight(
                        this.app,
                        this.version,
                        doctypeFolder,
                        this.chapterDir,
                    );
                    if (addedChapter) {
                        new Notice(`weights.json: added chapter "${this.chapterDir.replace(/^\d+-/, '')}"`);
                    }
                }
            } catch (e) {
                console.warn('[docs-cms] failed to patch weights.json:', e);
            }
        }

        new Notice(`Created ${targetPath}`);
        this.app.workspace.getLeaf(false).openFile(created);
        this.close();
    }

    /**
     * Try to discover the actual on-disk doctype folder under the version-language-bucket root
     * (e.g. "01-learn", "02-administrator"). Falls back to the bare doctype name if not found.
     */
    private findDoctypeFolder(): string {
        if (this.doctype === 'index') return '';
        const rootParts: string[] = [];
        if (this.version) rootParts.push(this.version);
        if (this.language) rootParts.push(this.language);
        rootParts.push(this.bucket);
        const root = rootParts.join('/');
        const parent = this.app.vault.getAbstractFileByPath(root);
        if (parent instanceof TFolder) {
            const match = parent.children.find(
                (c) => c instanceof TFolder && c.name.replace(/^\d+-/, '') === this.doctype,
            );
            if (match) return match.name;
        }
        return this.doctype;
    }
}

function renderYamlFrontmatter(obj: Record<string, unknown>): string {
    const lines = ['---'];
    for (const [k, v] of Object.entries(obj)) {
        if (v === undefined || v === null || v === '') continue;
        if (Array.isArray(v)) {
            lines.push(`${k}:`);
            for (const item of v) lines.push(`  - ${formatScalar(item)}`);
        } else if (typeof v === 'object') {
            lines.push(`${k}:`);
            for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
                if (v2 === undefined || v2 === null || v2 === '') continue;
                lines.push(`  ${k2}: ${formatScalar(v2)}`);
            }
        } else {
            lines.push(`${k}: ${formatScalar(v)}`);
        }
    }
    lines.push('---');
    return lines.join('\n') + '\n';
}

function formatScalar(v: unknown): string {
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    const s = String(v);
    if (/[:#\-\[\]\{\},&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s)) {
        return JSON.stringify(s);
    }
    return s;
}
