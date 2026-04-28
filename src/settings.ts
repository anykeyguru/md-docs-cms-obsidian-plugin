import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type DocsCmsPlugin from './main';

/**
 * Plugin settings.
 *
 * `attachmentsDir` is the source-of-truth value: it is mirrored both to plugin
 * data (so it survives across vaults) AND to `cms/cms.config.json` (so the
 * Next.js renderer reads the same value). The settings tab edits both.
 *
 * Other fields are plugin-only.
 */
export interface DocsCmsSettings {
    /** Folder name (relative to vault root) where ALL ![[...]] embeds resolve from. */
    attachmentsDir: string;

    /** Default author for new pages. */
    defaultAuthor: string;
    /** Default `appversion` for new pages. */
    defaultAppversion: string;
    /** Default language to open in the CMS Tree view. */
    defaultLanguage: 'en' | 'ru' | 'uz';

    /** Base URL of the rendered docs site, used by "Open on site" actions. */
    siteBaseUrl: string;

    /** Show a confirmation dialog before pushing. Off only if you really trust yourself. */
    gitPushRequiresConfirmation: boolean;
    /** Auto-pull (--rebase) before pushing if upstream is ahead. */
    gitPullBeforePush: boolean;

    /** When the health view scans, include files under drafts/ as well as public/. */
    healthIncludeDrafts: boolean;
    /** Glob-like substrings — any file path containing one of these is skipped by health check. */
    healthSkipPathPatterns: string[];
}

export const DEFAULT_SETTINGS: DocsCmsSettings = {
    attachmentsDir: '_shared-attachments',
    defaultAuthor: 'Admin Team',
    defaultAppversion: '1.0.0',
    defaultLanguage: 'ru',
    siteBaseUrl: 'http://localhost:3001',
    gitPushRequiresConfirmation: true,
    gitPullBeforePush: false,
    healthIncludeDrafts: false,
    healthSkipPathPatterns: ['documentation-plan'],
};

export class DocsCmsSettingTab extends PluginSettingTab {
    private plugin: DocsCmsPlugin;

    constructor(app: App, plugin: DocsCmsPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Docs CMS' });
        containerEl.createEl('p', {
            text: 'Manages docs-as-code workflows: frontmatter, draft promotion, health checks. Settings here are persisted in `.obsidian/plugins/docs-cms/data.json` and mirrored to `cms/cms.config.json` where the Next.js renderer reads them.',
            cls: 'setting-item-description',
        });

        // ── Engine-shared settings ─────────────────────────────────────────────
        containerEl.createEl('h3', { text: 'Engine-shared (also written to cms.config.json)' });

        new Setting(containerEl)
            .setName('Attachments folder')
            .setDesc('Single folder under the vault root where all ![[…]] embeds resolve from. Mirrors Obsidian\'s "Default location for new attachments" setting.')
            .addText((text) => {
                text.setPlaceholder('_shared-attachments')
                    .setValue(this.plugin.settings.attachmentsDir)
                    .onChange(async (value) => {
                        const trimmed = value.trim();
                        if (!trimmed) return;
                        this.plugin.settings.attachmentsDir = trimmed;
                        await this.plugin.saveSettings();
                    });
            })
            .addButton((btn) => {
                btn.setButtonText('Sync to cms.config.json')
                    .setCta()
                    .onClick(async () => {
                        try {
                            await this.plugin.updateConfig({
                                attachmentsDir: this.plugin.settings.attachmentsDir,
                            });
                            new Notice(`Wrote attachmentsDir → cms.config.json`);
                        } catch (e) {
                            new Notice(`Failed to write cms.config.json: ${e}`);
                        }
                    });
            });

        // ── Defaults for new files ────────────────────────────────────────────
        containerEl.createEl('h3', { text: 'Defaults for new pages' });

        new Setting(containerEl)
            .setName('Default author')
            .setDesc('Pre-filled in the New Page wizard frontmatter.')
            .addText((text) =>
                text.setValue(this.plugin.settings.defaultAuthor).onChange(async (v) => {
                    this.plugin.settings.defaultAuthor = v;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName('Default appversion')
            .setDesc('Pre-filled in the New Page wizard frontmatter (e.g. "1.0.0").')
            .addText((text) =>
                text.setValue(this.plugin.settings.defaultAppversion).onChange(async (v) => {
                    this.plugin.settings.defaultAppversion = v;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName('Default language')
            .setDesc('Initial language tab in the CMS Tree view.')
            .addDropdown((dd) => {
                dd.addOption('en', 'en');
                dd.addOption('ru', 'ru');
                dd.addOption('uz', 'uz');
                dd.setValue(this.plugin.settings.defaultLanguage).onChange(async (v) => {
                    this.plugin.settings.defaultLanguage = v as DocsCmsSettings['defaultLanguage'];
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName('Site base URL')
            .setDesc('Used by "Open on site" actions to launch the rendered page in your browser. No trailing slash.')
            .addText((text) =>
                text
                    .setPlaceholder('http://localhost:3001')
                    .setValue(this.plugin.settings.siteBaseUrl)
                    .onChange(async (v) => {
                        this.plugin.settings.siteBaseUrl = v.replace(/\/+$/, '');
                        await this.plugin.saveSettings();
                    }),
            );

        // ── Git ───────────────────────────────────────────────────────────────
        containerEl.createEl('h3', { text: 'Git (commit panel)' });

        new Setting(containerEl)
            .setName('Confirm before push')
            .setDesc('Show a confirmation dialog when clicking Sync. Recommended on shared branches.')
            .addToggle((tg) =>
                tg.setValue(this.plugin.settings.gitPushRequiresConfirmation).onChange(async (v) => {
                    this.plugin.settings.gitPushRequiresConfirmation = v;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName('Auto-rebase before push')
            .setDesc('Run `git pull --rebase` before `git push` when upstream is ahead. Off by default — surface conflicts at push time instead of letting them silently happen.')
            .addToggle((tg) =>
                tg.setValue(this.plugin.settings.gitPullBeforePush).onChange(async (v) => {
                    this.plugin.settings.gitPullBeforePush = v;
                    await this.plugin.saveSettings();
                }),
            );

        // ── Health check options ──────────────────────────────────────────────
        containerEl.createEl('h3', { text: 'Health check' });

        new Setting(containerEl)
            .setName('Include drafts')
            .setDesc('Also scan files under drafts/ for broken links/embeds. Off by default — drafts are work-in-progress.')
            .addToggle((tg) =>
                tg.setValue(this.plugin.settings.healthIncludeDrafts).onChange(async (v) => {
                    this.plugin.settings.healthIncludeDrafts = v;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName('Skip files matching')
            .setDesc('Comma-separated substrings; any file path containing one of these is skipped. Use for templates/meta-docs with intentional placeholders (e.g. "documentation-plan").')
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.healthSkipPathPatterns.join(', '))
                    .onChange(async (v) => {
                        this.plugin.settings.healthSkipPathPatterns = v
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean);
                        await this.plugin.saveSettings();
                    }),
            );

        // ── Structure ────────────────────────────────────────────────────────
        containerEl.createEl('h3', { text: 'Structure' });

        const s = this.plugin.config.structure;
        const summary = containerEl.createEl('div', { cls: 'setting-item' });
        const summaryInfo = summary.createEl('div', { cls: 'setting-item-info' });
        summaryInfo.createEl('div', { cls: 'setting-item-name', text: 'Current layout' });
        const desc = summaryInfo.createEl('div', { cls: 'setting-item-description' });
        desc.createEl('div', { text: `Layout: ${s.layout}` });
        if (s.languages.length > 0) {
            desc.createEl('div', { text: `Languages: ${s.languages.join(', ')}` });
        }
        desc.createEl('div', { text: `Buckets: ${s.buckets.join(', ')} (drafts="${s.draftsBucket}", public="${s.publicBucket}")` });
        desc.createEl('div', { text: `Doctypes: ${s.doctypes.join(', ')}` });

        new Setting(containerEl)
            .setName('Re-run setup wizard')
            .setDesc('Adjust layout, languages, bucket names. Re-running on a populated vault never moves or overwrites existing files — it only writes config and creates missing folders.')
            .addButton((btn) => {
                btn.setButtonText('Open setup wizard').onClick(async () => {
                    // Lazy import to avoid circular deps at module load
                    const { SetupWizardModal } = await import('./setup-wizard');
                    new SetupWizardModal(this.plugin).open();
                });
            });

        new Setting(containerEl)
            .setName('Verify CMS structure')
            .setDesc('Scan for orphan files, status↔bucket mismatches, frontmatter.chapter inconsistencies, and weights.json drift. Auto-fix is offered per issue.')
            .addButton((btn) => {
                btn.setButtonText('Run integrity check').onClick(async () => {
                    const { IntegrityCheckModal } = await import('./integrity');
                    new IntegrityCheckModal(this.plugin).open();
                });
            });
    }
}
