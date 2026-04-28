import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import { DocFrontmatter, Doctype, Status } from './types';

const DOCTYPES: Doctype[] = ['index', 'learn', 'developer', 'administrator'];
const STATUSES: Status[] = ['draft', 'published', 'deprecated'];

/** Modal form for editing the docs-CMS frontmatter contract. */
export class FrontmatterFormModal extends Modal {
    private file: TFile;
    private fm: DocFrontmatter = {};

    constructor(app: App, file: TFile) {
        super(app);
        this.file = file;
    }

    async onOpen() {
        const cache = this.app.metadataCache.getFileCache(this.file);
        this.fm = JSON.parse(JSON.stringify(cache?.frontmatter ?? {})) as DocFrontmatter;

        const { contentEl, titleEl } = this;
        titleEl.setText(`Edit frontmatter — ${this.file.basename}`);

        new Setting(contentEl).setName('doctype').addDropdown((dd) => {
            for (const t of DOCTYPES) dd.addOption(t, t);
            dd.setValue(this.fm.doctype ?? 'learn');
            dd.onChange((v) => (this.fm.doctype = v as Doctype));
        });

        new Setting(contentEl).setName('chapter').addText((t) => {
            t.setValue(this.fm.chapter ?? '');
            t.onChange((v) => (this.fm.chapter = v || undefined));
        });

        new Setting(contentEl).setName('weight').addText((t) => {
            t.setValue(this.fm.weight !== undefined ? String(this.fm.weight) : '');
            t.onChange((v) => {
                const n = v ? Number(v) : undefined;
                this.fm.weight = Number.isFinite(n) ? n : undefined;
            });
        });

        new Setting(contentEl).setName('title').addText((t) => {
            t.setValue(this.fm.title ?? '');
            t.onChange((v) => (this.fm.title = v || undefined));
        });

        new Setting(contentEl).setName('icon').addText((t) => {
            t.setValue(this.fm.icon ?? '');
            t.onChange((v) => (this.fm.icon = v || undefined));
        });

        new Setting(contentEl).setName('appversion').addText((t) => {
            t.setValue(this.fm.appversion ?? '1.0.0');
            t.onChange((v) => (this.fm.appversion = v || undefined));
        });

        const today = new Date().toISOString().split('T')[0];

        new Setting(contentEl).setName('date').addText((t) => {
            t.setPlaceholder('YYYY-MM-DD');
            t.setValue(this.fm.date ?? today);
            t.onChange((v) => (this.fm.date = v || undefined));
        });

        new Setting(contentEl).setName('updated').addText((t) => {
            t.setPlaceholder('YYYY-MM-DD');
            t.setValue(this.fm.updated ?? today);
            t.onChange((v) => (this.fm.updated = v || undefined));
        });

        new Setting(contentEl).setName('author').addText((t) => {
            t.setValue(this.fm.author ?? 'Admin Team');
            t.onChange((v) => (this.fm.author = v || undefined));
        });

        new Setting(contentEl).setName('tags').setDesc('comma-separated').addText((t) => {
            t.setValue((this.fm.tags ?? []).join(', '));
            t.onChange((v) => {
                const parsed = v.split(',').map((s) => s.trim()).filter(Boolean);
                this.fm.tags = parsed.length > 0 ? parsed : undefined;
            });
        });

        new Setting(contentEl).setName('seo.title').addText((t) => {
            t.setValue(this.fm.seo?.title ?? '');
            t.onChange((v) => {
                this.fm.seo = { ...(this.fm.seo ?? {}), title: v || undefined };
            });
        });

        new Setting(contentEl)
            .setName('seo.description')
            .setDesc('one-line summary used by search engines')
            .addTextArea((t) => {
                t.setValue(this.fm.seo?.description ?? '');
                t.inputEl.rows = 3;
                t.onChange((v) => {
                    this.fm.seo = { ...(this.fm.seo ?? {}), description: v || undefined };
                });
            });

        new Setting(contentEl).setName('status').addDropdown((dd) => {
            for (const s of STATUSES) dd.addOption(s, s);
            dd.setValue(this.fm.status ?? 'draft');
            dd.onChange((v) => (this.fm.status = v as Status));
        });

        const buttonRow = contentEl.createDiv({ cls: 'docs-cms-modal-buttons' });
        const save = buttonRow.createEl('button', { text: 'Save', cls: 'mod-cta' });
        save.onclick = () => this.save().catch((e) => new Notice(`Save failed: ${e}`));
        const cancel = buttonRow.createEl('button', { text: 'Cancel' });
        cancel.onclick = () => this.close();
    }

    onClose() {
        this.contentEl.empty();
    }

    private async save() {
        await this.app.fileManager.processFrontMatter(this.file, (fm) => {
            // Clean empty values from this.fm
            const clean = stripEmpty(this.fm);
            // Replace top-level keys we manage; keep keys we don't know about untouched.
            const managedKeys: (keyof DocFrontmatter)[] = [
                'doctype', 'chapter', 'weight', 'title', 'icon', 'appversion',
                'date', 'updated', 'author', 'tags', 'seo', 'status',
            ];
            for (const k of managedKeys) {
                const v = (clean as Record<string, unknown>)[k];
                if (v === undefined) {
                    delete (fm as Record<string, unknown>)[k];
                } else {
                    (fm as Record<string, unknown>)[k] = v;
                }
            }
        });
        new Notice('Frontmatter saved');
        this.close();
    }
}

function stripEmpty<T>(obj: T): T {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.filter((x) => x !== '' && x != null) as unknown as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (v === '' || v === null || v === undefined) continue;
        if (typeof v === 'object' && !Array.isArray(v)) {
            const nested = stripEmpty(v);
            if (nested && Object.keys(nested as object).length > 0) out[k] = nested;
        } else {
            out[k] = v;
        }
    }
    return out as T;
}
