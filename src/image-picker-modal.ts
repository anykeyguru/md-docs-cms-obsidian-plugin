import { App, Editor, MarkdownView, Modal, Notice, TFile, TFolder } from 'obsidian';
import type DocsCmsPlugin from './main';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif']);

/**
 * Modal that lists every file in the configured attachments folder with a
 * thumbnail + filename, lets the user search by basename, and inserts
 * `![[filename]]` (or markdown link for non-images) at the editor cursor.
 */
export class ImagePickerModal extends Modal {
    private plugin: DocsCmsPlugin;
    private editor: Editor;
    private files: TFile[] = [];
    private query = '';

    constructor(plugin: DocsCmsPlugin, editor: Editor) {
        super(plugin.app);
        this.plugin = plugin;
        this.editor = editor;
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText('Insert attachment');

        const folder = this.app.vault.getAbstractFileByPath(this.plugin.settings.attachmentsDir);
        if (!(folder instanceof TFolder)) {
            contentEl.createEl('p', {
                text: `Attachments folder "${this.plugin.settings.attachmentsDir}" not found at vault root.`,
                cls: 'setting-item-description',
            });
            return;
        }

        // Collect files (top-level only — flat folder convention)
        this.files = folder.children.filter((c): c is TFile => c instanceof TFile);

        const search = contentEl.createEl('input', {
            cls: 'docs-cms-picker-search',
            attr: { type: 'text', placeholder: 'Filter by filename…' },
        });
        search.oninput = () => {
            this.query = search.value.toLowerCase();
            this.renderGrid(grid);
        };
        // Auto-focus the search box
        setTimeout(() => search.focus(), 0);

        const grid = contentEl.createDiv({ cls: 'docs-cms-picker-grid' });
        this.renderGrid(grid);
    }

    onClose() {
        this.contentEl.empty();
    }

    private renderGrid(grid: HTMLElement) {
        grid.empty();
        const filtered = this.query
            ? this.files.filter((f) => f.name.toLowerCase().includes(this.query))
            : this.files;

        if (filtered.length === 0) {
            grid.createEl('p', { text: 'No matches.', cls: 'setting-item-description' });
            return;
        }

        for (const f of filtered) {
            const card = grid.createDiv({ cls: 'docs-cms-picker-card' });
            const ext = f.extension.toLowerCase();
            if (IMAGE_EXTS.has(ext)) {
                const img = card.createEl('img', { cls: 'docs-cms-picker-thumb' });
                img.src = this.app.vault.getResourcePath(f);
                img.alt = f.name;
                img.loading = 'lazy';
            } else {
                const ph = card.createDiv({ cls: 'docs-cms-picker-thumb docs-cms-picker-placeholder' });
                ph.setText(`.${ext}`);
            }
            card.createDiv({ cls: 'docs-cms-picker-name', text: f.name });
            card.onclick = () => this.insert(f);
        }
    }

    private insert(file: TFile) {
        // Always use Obsidian basename-only embed — engine resolves it via _shared-attachments
        const snippet = `![[${file.name}]]`;
        this.editor.replaceSelection(snippet);
        new Notice(`Inserted ![[${file.name}]]`);
        this.close();
    }
}

/** Open the picker for the active markdown editor. */
export function openImagePicker(plugin: DocsCmsPlugin): void {
    const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
        new Notice('Open a markdown file first');
        return;
    }
    new ImagePickerModal(plugin, view.editor).open();
}
