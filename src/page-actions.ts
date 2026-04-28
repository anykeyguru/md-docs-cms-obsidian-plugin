import { App, Menu, Modal, Notice, Setting, TFile, normalizePath } from 'obsidian';
import { Bucket, Language, ParsedPath, bucketPath, parseDocPath } from './paths';
import { FrontmatterFormModal } from './frontmatter-form';
import { demoteToDrafts, ensureFolder, preflight, promote } from './promote';
import type DocsCmsPlugin from './main';
import { DocFrontmatter } from './types';

/**
 * Open the context menu for a file in the CMS tree.
 * `evt` is the originating click/right-click event, used for positioning.
 */
export function showPageMenu(plugin: DocsCmsPlugin, file: TFile, evt: MouseEvent | PointerEvent): void {
    const menu = new Menu();
    const parsed = parseDocPath(file.path);

    menu.addItem((it) =>
        it.setTitle('Open').setIcon('file').onClick(() => {
            plugin.app.workspace.getLeaf(false).openFile(file);
        }),
    );

    menu.addItem((it) =>
        it.setTitle('Edit frontmatter').setIcon('edit').onClick(() => {
            new FrontmatterFormModal(plugin.app, file).open();
        }),
    );

    if (parsed?.isPublic) {
        menu.addItem((it) =>
            it.setTitle('Open on site').setIcon('external-link').onClick(() => {
                openOnSite(plugin, parsed);
            }),
        );
    }

    if (parsed?.isDrafts) {
        menu.addItem((it) =>
            it.setTitle('Promote to public').setIcon('arrow-up').onClick(async () => {
                await runPromote(plugin, file);
            }),
        );
    } else if (parsed?.isPublic) {
        menu.addItem((it) =>
            it.setTitle('Demote to drafts').setIcon('arrow-down').onClick(async () => {
                await demoteToDrafts(plugin.app, file);
            }),
        );
    }

    if (parsed && parsed.language) {
        menu.addItem((it) =>
            it.setTitle('Duplicate as draft in another language…').setIcon('languages').onClick(() => {
                new DuplicateLanguageModal(plugin, file, parsed).open();
            }),
        );
    }

    menu.addSeparator();

    menu.addItem((it) =>
        it.setTitle('Rename…').setIcon('pencil').onClick(() => {
            new RenameModal(plugin.app, file).open();
        }),
    );

    menu.addItem((it) =>
        it.setTitle('Delete')
            .setIcon('trash')
            .setSection('danger')
            .onClick(() => {
                new ConfirmDeleteModal(plugin.app, file).open();
            }),
    );

    menu.showAtMouseEvent(evt);
}

/** Open the page on the rendered site (default http://localhost:3001). */
export function openOnSite(plugin: DocsCmsPlugin, parsed: ParsedPath): void {
    const baseUrl = plugin.settings.siteBaseUrl.replace(/\/+$/, '');
    const slug = parsed.relPath.replace(/\.(mdx?|md)$/, '');
    const parts: string[] = [baseUrl, 'docs'];
    if (parsed.language) parts.push(parsed.language);
    if (parsed.version) parts.push(parsed.version);
    parts.push(slug);
    window.open(parts.join('/'), '_blank');
}

async function runPromote(plugin: DocsCmsPlugin, file: TFile) {
    const issues = await preflight(plugin.app, file, { attachmentsDir: plugin.settings.attachmentsDir });
    if (issues.length === 0) {
        await promote(plugin.app, file);
        return;
    }
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length > 0) {
        new Notice(`Cannot promote — ${errors.length} error(s). Run "Promote current draft" command for details.`);
        return;
    }
    // Only warnings — proceed
    await promote(plugin.app, file);
}

class RenameModal extends Modal {
    private file: TFile;
    private newName: string;
    private newTitle: string;
    private syncTitle = true;

    constructor(app: App, file: TFile) {
        super(app);
        this.file = file;
        this.newName = file.basename;
        const fm = (app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as DocFrontmatter;
        this.newTitle = fm.title ?? file.basename;
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText(`Rename — ${this.file.name}`);

        new Setting(contentEl)
            .setName('Filename (without extension)')
            .addText((t) => {
                t.setValue(this.newName).onChange((v) => (this.newName = v.trim()));
                t.inputEl.style.width = '100%';
            });

        new Setting(contentEl)
            .setName('Frontmatter title')
            .setDesc('What appears in the sidebar / breadcrumbs on the rendered site.')
            .addText((t) => {
                t.setValue(this.newTitle).onChange((v) => (this.newTitle = v));
                t.inputEl.style.width = '100%';
            });

        new Setting(contentEl).setName('Update both').setDesc('If off, only the filename is renamed.').addToggle((tg) =>
            tg.setValue(this.syncTitle).onChange((v) => (this.syncTitle = v)),
        );

        const buttons = contentEl.createDiv({ cls: 'docs-cms-modal-buttons' });
        const ok = buttons.createEl('button', { text: 'Rename', cls: 'mod-cta' });
        ok.onclick = async () => {
            try {
                if (this.newName && this.newName !== this.file.basename) {
                    const dir = this.file.parent?.path ?? '';
                    const target = normalizePath(`${dir}/${this.newName}.${this.file.extension}`);
                    await this.app.fileManager.renameFile(this.file, target);
                }
                if (this.syncTitle) {
                    await this.app.fileManager.processFrontMatter(this.file, (fm) => {
                        (fm as Record<string, unknown>).title = this.newTitle;
                    });
                }
                new Notice(`Renamed`);
                this.close();
            } catch (e) {
                new Notice(`Rename failed: ${e}`);
            }
        };
        const cancel = buttons.createEl('button', { text: 'Cancel' });
        cancel.onclick = () => this.close();
    }

    onClose() {
        this.contentEl.empty();
    }
}

class ConfirmDeleteModal extends Modal {
    private file: TFile;

    constructor(app: App, file: TFile) {
        super(app);
        this.file = file;
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText(`Delete ${this.file.name}?`);
        contentEl.createEl('p', {
            text: `Move "${this.file.path}" to system trash? Backlinks in other files will not be updated.`,
        });

        const buttons = contentEl.createDiv({ cls: 'docs-cms-modal-buttons' });
        const ok = buttons.createEl('button', { text: 'Delete', cls: 'mod-warning' });
        ok.onclick = async () => {
            try {
                await this.app.vault.trash(this.file, true);
                new Notice(`Deleted ${this.file.path}`);
                this.close();
            } catch (e) {
                new Notice(`Delete failed: ${e}`);
            }
        };
        const cancel = buttons.createEl('button', { text: 'Cancel' });
        cancel.onclick = () => this.close();
    }

    onClose() {
        this.contentEl.empty();
    }
}

class DuplicateLanguageModal extends Modal {
    private plugin: DocsCmsPlugin;
    private source: TFile;
    private parsed: ParsedPath;
    private targetLang: Language;
    private targetBucket: Bucket;

    constructor(plugin: DocsCmsPlugin, source: TFile, parsed: ParsedPath) {
        super(plugin.app);
        this.plugin = plugin;
        this.source = source;
        this.parsed = parsed;
        const langs = plugin.config.structure.languages;
        this.targetLang = langs.find((l) => l !== parsed.language) ?? langs[0] ?? 'en';
        this.targetBucket = plugin.config.structure.draftsBucket;
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText(`Duplicate "${this.source.name}" to another language`);

        const { languages, buckets, draftsBucket, publicBucket } = this.plugin.config.structure;

        new Setting(contentEl).setName('Target language').addDropdown((dd) => {
            for (const l of languages) {
                if (l !== this.parsed.language) dd.addOption(l, l);
            }
            dd.setValue(this.targetLang).onChange((v) => (this.targetLang = v));
        });

        new Setting(contentEl).setName('Target bucket').addDropdown((dd) => {
            for (const b of buckets) {
                const label = b === draftsBucket ? `${b} (recommended)` :
                              b === publicBucket ? `${b} (skip translation review!)` : b;
                dd.addOption(b, label);
            }
            dd.setValue(this.targetBucket).onChange((v) => (this.targetBucket = v));
        });

        contentEl.createEl('p', {
            text: 'Creates a copy in the target language with the same relative path. The copy starts with status: draft and source-language tracking fields filled in.',
            cls: 'setting-item-description',
        });

        const buttons = contentEl.createDiv({ cls: 'docs-cms-modal-buttons' });
        const ok = buttons.createEl('button', { text: 'Create', cls: 'mod-cta' });
        ok.onclick = () => this.duplicate().catch((e) => new Notice(`Failed: ${e}`));
        const cancel = buttons.createEl('button', { text: 'Cancel' });
        cancel.onclick = () => this.close();
    }

    onClose() {
        this.contentEl.empty();
    }

    private async duplicate() {
        const app = this.plugin.app;
        const target = normalizePath(
            bucketPath(this.parsed.version, this.targetLang, this.targetBucket, this.parsed.relPath),
        );
        const existing = app.vault.getAbstractFileByPath(target);
        if (existing) {
            new Notice(`Target already exists: ${target}`);
            return;
        }
        await ensureFolder(app, target);
        const text = await app.vault.read(this.source);
        const created = await app.vault.create(target, text);

        await app.fileManager.processFrontMatter(created, (fm) => {
            (fm as Record<string, unknown>).status = 'draft';
            (fm as Record<string, unknown>).source_lang = this.parsed.language;
            (fm as Record<string, unknown>).source_path = this.source.path;
            (fm as Record<string, unknown>).translation_status = 'stale';
        });

        new Notice(`Created ${target}`);
        app.workspace.getLeaf(false).openFile(created);
        this.close();
    }
}
