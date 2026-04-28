import { App, MarkdownView, Modal, Notice, Plugin, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { FrontmatterFormModal } from './frontmatter-form';
import { preflight, promote } from './promote';
import { HEALTH_VIEW_TYPE, HealthView } from './health-view';
import { CMS_TREE_VIEW_TYPE, CmsTreeView } from './cms-tree-view';
import { TRANSLATION_MATRIX_VIEW_TYPE, TranslationMatrixView } from './translation-matrix-view';
import { NewPageModal } from './new-page-modal';
import { DEFAULT_SETTINGS, DocsCmsSettingTab, DocsCmsSettings } from './settings';
import { openImagePicker } from './image-picker-modal';
import { openOnSite } from './page-actions';
import { initPathSchema, parseDocPath } from './paths';
import { CmsConfig, isVersioned, loadCmsConfig, writeCmsConfig } from './cms-config';
import { SetupWizardModal, shouldAutoOpen } from './setup-wizard';
import { IntegrityCheckModal } from './integrity';
import { HelpModal } from './help-modal';
import { PreflightIssue } from './types';

export default class DocsCmsPlugin extends Plugin {
    settings!: DocsCmsSettings;
    /** Engine config — shared with the Next.js renderer via `cms.config.json`. */
    config!: CmsConfig;

    async onload() {
        console.log('[docs-cms] loading');

        await this.loadSettings();

        // Register custom views
        this.registerView(HEALTH_VIEW_TYPE, (leaf) => new HealthView(leaf, this));
        this.registerView(CMS_TREE_VIEW_TYPE, (leaf) => new CmsTreeView(leaf, this));
        this.registerView(TRANSLATION_MATRIX_VIEW_TYPE, (leaf) => new TranslationMatrixView(leaf, this));

        this.addSettingTab(new DocsCmsSettingTab(this.app, this));

        this.registerCommands();

        this.addRibbonIcon('book-open', 'Docs CMS — open tree', () => {
            this.activateView(CMS_TREE_VIEW_TYPE, 'left');
        });
        this.addRibbonIcon('languages', 'Docs CMS — translation matrix', () => {
            this.activateView(TRANSLATION_MATRIX_VIEW_TYPE, 'main');
        });
        this.addRibbonIcon('shield-check', 'Docs CMS — health check', () => {
            this.activateView(HEALTH_VIEW_TYPE, 'right');
        });

        // Auto-launch the setup wizard for completely empty vaults.
        this.app.workspace.onLayoutReady(() => {
            if (shouldAutoOpen(this)) {
                new SetupWizardModal(this).open();
            }
        });
    }

    onunload() {
        console.log('[docs-cms] unloading');
    }

    private registerCommands() {
        this.addCommand({
            id: 'open-cms-tree',
            name: 'Open CMS tree',
            callback: () => this.activateView(CMS_TREE_VIEW_TYPE, 'left'),
        });

        this.addCommand({
            id: 'open-commit-panel',
            name: 'Open commit panel (source control)',
            callback: () => this.openCommitPanel().catch((e) => new Notice(`Failed: ${e}`)),
        });

        this.addCommand({
            id: 'open-translation-matrix',
            name: 'Open translation matrix',
            callback: () => this.activateView(TRANSLATION_MATRIX_VIEW_TYPE, 'main'),
        });

        this.addCommand({
            id: 'new-page',
            name: 'New page…',
            callback: () => new NewPageModal(this).open(),
        });

        this.addCommand({
            id: 'edit-frontmatter',
            name: 'Edit frontmatter',
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || !view.file) return false;
                if (!checking) new FrontmatterFormModal(this.app, view.file).open();
                return true;
            },
        });

        this.addCommand({
            id: 'promote-draft',
            name: 'Promote current draft to public',
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || !view.file) return false;
                if (!checking) {
                    this.promoteWithPreflight(view.file).catch((e) => new Notice(`Promote failed: ${e}`));
                }
                return true;
            },
        });

        this.addCommand({
            id: 'open-on-site',
            name: 'Open current page on site',
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || !view.file) return false;
                const parsed = parseDocPath(view.file.path);
                if (!parsed || !parsed.isPublic) return false;
                if (!checking) openOnSite(this, parsed);
                return true;
            },
        });

        this.addCommand({
            id: 'insert-attachment',
            name: 'Insert attachment (image picker)',
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view) return false;
                if (!checking) openImagePicker(this);
                return true;
            },
        });

        this.addCommand({
            id: 'open-health-view',
            name: 'Open health view (broken links and embeds)',
            callback: () => this.activateView(HEALTH_VIEW_TYPE, 'right'),
        });

        this.addCommand({
            id: 'setup-wizard',
            name: 'Set up CMS structure…',
            callback: () => new SetupWizardModal(this).open(),
        });

        this.addCommand({
            id: 'verify-structure',
            name: 'Verify CMS structure (integrity check)',
            callback: () => new IntegrityCheckModal(this).open(),
        });

        this.addCommand({
            id: 'show-help',
            name: 'Show help',
            callback: () => new HelpModal(this).open(),
        });
    }

    // ── Settings & config persistence ─────────────────────────────────────────
    async loadSettings() {
        const persisted = (await this.loadData()) as Partial<DocsCmsSettings> | null;
        this.settings = { ...DEFAULT_SETTINGS, ...(persisted ?? {}) };

        this.config = await loadCmsConfig(this.app);
        // Mirror engine-shared field into settings for the UI
        this.settings.attachmentsDir = this.config.attachmentsDir;
        await this.saveData(this.settings);

        initPathSchema(this.config.structure);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    /**
     * Re-apply config after a setup-wizard run or settings change. Re-inits the
     * path schema and refreshes any open views.
     */
    async applyConfig() {
        initPathSchema(this.config.structure);
        // Refresh open custom views
        for (const t of [CMS_TREE_VIEW_TYPE, TRANSLATION_MATRIX_VIEW_TYPE, HEALTH_VIEW_TYPE]) {
            for (const leaf of this.app.workspace.getLeavesOfType(t)) {
                const view = leaf.view as unknown as { refresh?: () => Promise<void>; render?: () => void };
                if (typeof view.refresh === 'function') await view.refresh();
                else if (typeof view.render === 'function') view.render();
            }
        }
    }

    /** Persist a single field to cms.config.json AND in-memory state. */
    async updateConfig(patch: Partial<CmsConfig>) {
        this.config = { ...this.config, ...patch };
        await writeCmsConfig(this.app, this.config);
        await this.applyConfig();
    }

    // ── Vault helpers ─────────────────────────────────────────────────────────
    detectVersions(): string[] {
        if (!isVersioned(this.config.structure)) return [];
        const root = this.app.vault.getRoot();
        const out: string[] = [];
        const re = new RegExp(`^${this.config.structure.versionPattern}$`);
        for (const child of root.children) {
            if (child instanceof TFolder && re.test(child.name)) {
                out.push(child.name);
            }
        }
        return out.sort().reverse();
    }

    /** Open the CMS tree view and toggle it into commit mode. */
    async openCommitPanel(): Promise<void> {
        await this.activateView(CMS_TREE_VIEW_TYPE, 'left');
        const leaf = this.app.workspace.getLeavesOfType(CMS_TREE_VIEW_TYPE)[0];
        if (!leaf) return;
        const view = leaf.view as unknown as { mode?: string; refresh?: () => Promise<void> };
        (view as Record<string, unknown>)['mode'] = 'commit';
        if (typeof view.refresh === 'function') await view.refresh();
    }

    private async activateView(viewType: string, side: 'left' | 'right' | 'main'): Promise<void> {
        const { workspace } = this.app;
        const existing = workspace.getLeavesOfType(viewType)[0];
        if (existing) {
            workspace.revealLeaf(existing);
            return;
        }
        let leaf: WorkspaceLeaf | null;
        if (side === 'main') {
            leaf = workspace.getLeaf(true);
        } else if (side === 'left') {
            leaf = workspace.getLeftLeaf(false);
        } else {
            leaf = workspace.getRightLeaf(false);
        }
        if (!leaf) {
            new Notice(`No ${side} leaf available`);
            return;
        }
        await leaf.setViewState({ type: viewType, active: true });
        workspace.revealLeaf(leaf);
    }

    async promoteWithPreflight(file: TFile) {
        const issues = await preflight(this.app, file, { attachmentsDir: this.settings.attachmentsDir });
        if (issues.length === 0) {
            await promote(this.app, file);
            return;
        }
        new PreflightModal(this.app, file, issues, async () => {
            await promote(this.app, file);
        }).open();
    }
}

class PreflightModal extends Modal {
    private file: TFile;
    private issues: PreflightIssue[];
    private onProceed: () => Promise<void>;

    constructor(app: App, file: TFile, issues: PreflightIssue[], onProceed: () => Promise<void>) {
        super(app);
        this.file = file;
        this.issues = issues;
        this.onProceed = onProceed;
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText(`Preflight — ${this.file.basename}`);

        const errors = this.issues.filter((i) => i.severity === 'error');
        const warnings = this.issues.filter((i) => i.severity === 'warning');

        if (errors.length > 0) {
            contentEl.createEl('h4', {
                text: `Errors (${errors.length}) — must fix before promoting:`,
            });
            const ul = contentEl.createEl('ul');
            for (const e of errors) ul.createEl('li', { text: e.message });
        }

        if (warnings.length > 0) {
            contentEl.createEl('h4', {
                text: `Warnings (${warnings.length}) — promote allowed, but check:`,
            });
            const ul = contentEl.createEl('ul');
            for (const w of warnings) ul.createEl('li', { text: w.message });
        }

        const buttonRow = contentEl.createDiv({ cls: 'docs-cms-modal-buttons' });
        if (errors.length === 0) {
            const proceed = buttonRow.createEl('button', {
                text: 'Promote anyway',
                cls: 'mod-cta',
            });
            proceed.onclick = async () => {
                this.close();
                try {
                    await this.onProceed();
                } catch (e) {
                    new Notice(`Promote failed: ${e}`);
                }
            };
        }
        const cancel = buttonRow.createEl('button', { text: 'Cancel' });
        cancel.onclick = () => this.close();
    }

    onClose() {
        this.contentEl.empty();
    }
}
