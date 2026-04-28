import { App, Modal, Notice, Setting, TFolder, normalizePath } from 'obsidian';
import {
    CmsConfig,
    DEFAULT_CONFIG,
    DEFAULT_FRONTMATTER,
    DEFAULT_STRUCTURE,
    Layout,
    StructureConfig,
    writeCmsConfig,
} from './cms-config';
import type DocsCmsPlugin from './main';

const LAYOUT_DESCRIPTIONS: Record<Layout, string> = {
    'versioned-multilang': '{version}/{language}/{bucket}/… — versioned multi-language site',
    'versioned-monolang': '{version}/{bucket}/… — versioned single-language site',
    'flat-multilang': '{language}/{bucket}/… — single-version multi-language',
    'flat-monolang': '{bucket}/… — single-version single-language',
};

/**
 * First-run scaffold: creates the directory skeleton and writes cms.config.json.
 * Triggered automatically on plugin load when no cms.config.json exists AND the
 * vault has no markdown files matching the default schema.
 *
 * Re-runnable via the `Docs CMS: Set up CMS structure…` command.
 */
export class SetupWizardModal extends Modal {
    private plugin: DocsCmsPlugin;
    private layout: Layout = 'versioned-multilang';
    private startingVersion: string = 'v1.0.0';
    private languages: string = 'en, ru, uz';
    private attachmentsDir: string = '_shared-attachments';
    private draftsBucket: string = 'drafts';
    private publicBucket: string = 'public';
    private doctypes: string = 'index, learn, developer, administrator';
    private createInitialPage: boolean = true;

    constructor(plugin: DocsCmsPlugin) {
        super(plugin.app);
        this.plugin = plugin;

        // Pre-fill from existing config if available
        const cur = plugin.config?.structure ?? DEFAULT_STRUCTURE;
        this.layout = cur.layout;
        this.languages = cur.languages.join(', ');
        this.attachmentsDir = plugin.config?.attachmentsDir ?? DEFAULT_CONFIG.attachmentsDir;
        this.draftsBucket = cur.draftsBucket;
        this.publicBucket = cur.publicBucket;
        this.doctypes = cur.doctypes.join(', ');
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText('Set up Docs CMS');

        contentEl.createEl('p', {
            text: 'This wizard scaffolds the directory layout and writes cms.config.json. Re-run it any time from the command palette to adjust structure (existing files are never moved or overwritten).',
            cls: 'setting-item-description',
        });

        new Setting(contentEl).setName('Layout').setDesc(LAYOUT_DESCRIPTIONS[this.layout]).addDropdown((dd) => {
            for (const k of Object.keys(LAYOUT_DESCRIPTIONS) as Layout[]) {
                dd.addOption(k, k);
            }
            dd.setValue(this.layout);
            dd.onChange((v) => {
                this.layout = v as Layout;
                this.onOpen.call(this); // re-render with updated descriptions
                contentEl.empty();
                this.onOpen();
            });
        });

        if (this.layout.startsWith('versioned-')) {
            new Setting(contentEl)
                .setName('Starting version')
                .setDesc('Directory like v1.0.0 created at vault root.')
                .addText((t) => {
                    t.setValue(this.startingVersion).onChange((v) => (this.startingVersion = v.trim()));
                });
        }

        if (this.layout.endsWith('-multilang')) {
            new Setting(contentEl)
                .setName('Languages')
                .setDesc('Comma-separated. e.g. "en, ru, uz".')
                .addText((t) => {
                    t.setValue(this.languages).onChange((v) => (this.languages = v));
                });
        }

        new Setting(contentEl)
            .setName('Drafts bucket name')
            .addText((t) => t.setValue(this.draftsBucket).onChange((v) => (this.draftsBucket = v.trim())));

        new Setting(contentEl)
            .setName('Public bucket name')
            .addText((t) => t.setValue(this.publicBucket).onChange((v) => (this.publicBucket = v.trim())));

        new Setting(contentEl)
            .setName('Attachments folder')
            .setDesc('Created at vault root; used for all ![[…]] embeds.')
            .addText((t) => t.setValue(this.attachmentsDir).onChange((v) => (this.attachmentsDir = v.trim())));

        new Setting(contentEl)
            .setName('Doctypes')
            .setDesc('Comma-separated, used as default frontmatter.doctype values.')
            .addText((t) => t.setValue(this.doctypes).onChange((v) => (this.doctypes = v)));

        new Setting(contentEl)
            .setName('Create starter page')
            .setDesc('Generate a template overview.md in the public bucket.')
            .addToggle((tg) => tg.setValue(this.createInitialPage).onChange((v) => (this.createInitialPage = v)));

        const buttons = contentEl.createDiv({ cls: 'docs-cms-modal-buttons' });
        const ok = buttons.createEl('button', { text: 'Create structure', cls: 'mod-cta' });
        ok.onclick = () => this.run().catch((e) => new Notice(`Setup failed: ${e}`));
        const cancel = buttons.createEl('button', { text: 'Cancel' });
        cancel.onclick = () => this.close();
    }

    onClose() {
        this.contentEl.empty();
    }

    private parseList(s: string): string[] {
        return s.split(',').map((x) => x.trim()).filter(Boolean);
    }

    private async run() {
        const langs = this.parseList(this.languages);
        const doctypes = this.parseList(this.doctypes);

        if (this.layout.endsWith('-multilang') && langs.length === 0) {
            new Notice('At least one language is required for the chosen layout');
            return;
        }
        if (!this.draftsBucket || !this.publicBucket) {
            new Notice('Bucket names are required');
            return;
        }
        if (!this.attachmentsDir) {
            new Notice('Attachments folder name is required');
            return;
        }

        const structure: StructureConfig = {
            layout: this.layout,
            versionPattern: DEFAULT_STRUCTURE.versionPattern,
            languages: this.layout.endsWith('-multilang') ? langs : [],
            buckets: [this.draftsBucket, this.publicBucket],
            publicBucket: this.publicBucket,
            draftsBucket: this.draftsBucket,
            doctypes: doctypes.length > 0 ? doctypes : DEFAULT_STRUCTURE.doctypes,
        };

        const config: CmsConfig = {
            attachmentsDir: this.attachmentsDir,
            structure,
            frontmatter: DEFAULT_FRONTMATTER,
        };

        // 1. Write cms.config.json
        await writeCmsConfig(this.app, config);

        // 2. Create directories
        const created: string[] = [];
        await ensureFolder(this.app, this.attachmentsDir, created);

        const versions = this.layout.startsWith('versioned-') ? [this.startingVersion] : [''];
        const langsForCreation = this.layout.endsWith('-multilang') ? langs : [''];
        for (const v of versions) {
            for (const l of langsForCreation) {
                for (const b of [this.draftsBucket, this.publicBucket]) {
                    const parts = [v, l, b].filter(Boolean);
                    const dir = parts.join('/');
                    await ensureFolder(this.app, dir, created);
                }
            }
        }

        // 3. Optionally create a starter page in public
        if (this.createInitialPage) {
            const v = this.layout.startsWith('versioned-') ? this.startingVersion : '';
            const l = this.layout.endsWith('-multilang') ? langs[0] : '';
            const parts = [v, l, this.publicBucket].filter(Boolean);
            const overviewBase = `${parts.join('/')}/overview`;
            const overviewPath = normalizePath(`${overviewBase}.md`);
            // Only create if NEITHER .md nor .mdx already exists — otherwise we'd
            // produce a duplicate slug and crash the React sidebar with two children
            // sharing the same key.
            const existingMd = this.app.vault.getAbstractFileByPath(overviewPath);
            const existingMdx = this.app.vault.getAbstractFileByPath(normalizePath(`${overviewBase}.mdx`));
            if (!existingMd && !existingMdx) {
                const today = new Date().toISOString().split('T')[0];
                const fm = [
                    '---',
                    'doctype: index',
                    'chapter: index',
                    'weight: 1',
                    'title: Overview',
                    `appversion: ${this.layout.startsWith('versioned-') ? this.startingVersion.replace(/^v/, '') : '1.0.0'}`,
                    `date: ${today}`,
                    `updated: ${today}`,
                    'author: Admin Team',
                    'status: published',
                    '---',
                    '',
                    '## Overview',
                    '',
                    'Welcome. Edit this page to introduce your documentation.',
                    '',
                ].join('\n');
                await this.app.vault.create(overviewPath, fm);
                created.push(overviewPath);
            }
        }

        new Notice(`Created ${created.length} folders/files. Reload the plugin to apply structure changes.`);

        // Re-init the path schema so the running plugin uses the new structure immediately
        this.plugin.config = config;
        await this.plugin.applyConfig();

        this.close();
    }
}

async function ensureFolder(app: App, dir: string, log: string[]): Promise<void> {
    if (!dir) return;
    const path = normalizePath(dir);
    const af = app.vault.getAbstractFileByPath(path);
    if (af instanceof TFolder) return;
    if (af) throw new Error(`Path "${path}" exists but is not a folder`);
    await app.vault.createFolder(path);
    log.push(path);
}

/**
 * Decide whether the wizard should pop up automatically: only when the vault
 * looks completely empty for our purposes (no config, no matching files).
 */
export function shouldAutoOpen(plugin: DocsCmsPlugin): boolean {
    // A) No cms.config.json on disk AND
    // B) No markdown file matches the current schema.
    const cfgFile = plugin.app.vault.getAbstractFileByPath('cms.config.json');
    if (cfgFile) return false;
    let matched = 0;
    for (const f of plugin.app.vault.getMarkdownFiles()) {
        const re = /^(v\d+\.\d+\.\d+\/)?[^/]+\/(public|drafts)\//;
        if (re.test(f.path)) {
            matched++;
            if (matched > 0) return false;
        }
    }
    return true;
}
