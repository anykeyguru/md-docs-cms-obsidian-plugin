import { App, Modal, Notice, TFile, TFolder, normalizePath } from 'obsidian';
import { hasLanguages, isVersioned, StructureConfig } from './cms-config';
import { getPathSchema, parseDocPath } from './paths';
import { readWeights } from './weights';
import { DocFrontmatter } from './types';
import type DocsCmsPlugin from './main';

export interface IntegrityIssue {
    code:
        | 'orphan-file'
        | 'status-bucket-mismatch'
        | 'chapter-mismatch'
        | 'weights-orphan-doctype'
        | 'weights-orphan-chapter'
        | 'weights-missing-doctype'
        | 'weights-missing-chapter';
    severity: 'error' | 'warning';
    file?: string;
    message: string;
    fix?: () => Promise<void>;
}

/**
 * Run all structural integrity checks and return a flat list of issues.
 * Each issue may carry a `fix` callback for auto-repair.
 */
export async function runIntegrityCheck(plugin: DocsCmsPlugin): Promise<IntegrityIssue[]> {
    const issues: IntegrityIssue[] = [];
    const app = plugin.app;
    const structure = plugin.config.structure;
    const schema = getPathSchema();

    // ── 1. Orphan markdown files (under no known bucket) ─────────────────────
    for (const f of app.vault.getMarkdownFiles()) {
        const p = parseDocPath(f.path);
        if (!p) {
            // Skip files at vault root (could be the user's index notes outside CMS)
            if (!f.path.includes('/')) continue;
            // Skip files explicitly in attachments dir (shouldn't be markdown there but defensive)
            if (f.path.startsWith(plugin.config.attachmentsDir + '/')) continue;
            issues.push({
                code: 'orphan-file',
                severity: 'warning',
                file: f.path,
                message: `${f.path} doesn't match the expected layout (${structure.layout}).`,
            });
        }
    }

    // ── 2. Status ↔ bucket mismatch ──────────────────────────────────────────
    for (const f of app.vault.getMarkdownFiles()) {
        const p = parseDocPath(f.path);
        if (!p) continue;
        const fm = (app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as DocFrontmatter;
        if (!fm.status) continue;

        if (p.isPublic && fm.status === 'draft') {
            issues.push({
                code: 'status-bucket-mismatch',
                severity: 'error',
                file: f.path,
                message: `Published file has status "draft" — site filters drafts out, so this page won't render.`,
                fix: async () => {
                    await app.fileManager.processFrontMatter(f, (m) => {
                        (m as Record<string, unknown>).status = 'published';
                    });
                },
            });
        }
        if (p.isDrafts && fm.status === 'published') {
            issues.push({
                code: 'status-bucket-mismatch',
                severity: 'warning',
                file: f.path,
                message: `Draft file has status "published" — confusing; status should be "draft" while in drafts/.`,
                fix: async () => {
                    await app.fileManager.processFrontMatter(f, (m) => {
                        (m as Record<string, unknown>).status = 'draft';
                    });
                },
            });
        }
    }

    // ── 3. frontmatter.chapter doesn't match the chapter folder ─────────────
    for (const f of app.vault.getMarkdownFiles()) {
        const p = parseDocPath(f.path);
        if (!p) continue;
        const segments = p.relPath.split('/');
        if (segments.length < 3) continue;
        const chapterFolder = segments[1];
        const chapterSlug = chapterFolder.replace(/^\d+-/, '');

        const fm = (app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as DocFrontmatter;
        if (!fm.chapter) continue;
        if (fm.chapter !== chapterSlug) {
            issues.push({
                code: 'chapter-mismatch',
                severity: 'warning',
                file: f.path,
                message: `frontmatter.chapter is "${fm.chapter}" but folder is "${chapterFolder}" → expected chapter "${chapterSlug}".`,
                fix: async () => {
                    await app.fileManager.processFrontMatter(f, (m) => {
                        (m as Record<string, unknown>).chapter = chapterSlug;
                    });
                },
            });
        }
    }

    // ── 4. weights.json consistency (versioned layouts only) ─────────────────
    if (isVersioned(structure)) {
        const versions = plugin.detectVersions();
        for (const version of versions) {
            const w = await readWeights(app, version);

            // Collect actual doctypes/chapters from disk for this version
            const onDisk = collectDoctypeChapters(app, version, structure);

            const knownDoctypes = new Set(Object.keys(w.doctype_weight ?? {}));
            const realDoctypes = new Set([...onDisk.keys()].map(stripPrefix));

            for (const wd of knownDoctypes) {
                if (!realDoctypes.has(wd)) {
                    issues.push({
                        code: 'weights-orphan-doctype',
                        severity: 'warning',
                        message: `weights.json (${version}): doctype "${wd}" listed but not present on disk.`,
                    });
                }
            }
            for (const rd of realDoctypes) {
                if (!knownDoctypes.has(rd)) {
                    issues.push({
                        code: 'weights-missing-doctype',
                        severity: 'warning',
                        message: `weights.json (${version}): doctype "${rd}" exists on disk but missing from weights.json.`,
                    });
                }
            }

            for (const [doctypeFolder, chapterFolders] of onDisk) {
                const dSlug = stripPrefix(doctypeFolder);
                const knownChapters = new Set(Object.keys(w.chapter_weight?.[dSlug] ?? {}));
                const realChapters = new Set([...chapterFolders].map(stripPrefix));
                for (const wc of knownChapters) {
                    if (!realChapters.has(wc)) {
                        issues.push({
                            code: 'weights-orphan-chapter',
                            severity: 'warning',
                            message: `weights.json (${version}/${dSlug}): chapter "${wc}" listed but not present on disk.`,
                        });
                    }
                }
                for (const rc of realChapters) {
                    if (!knownChapters.has(rc)) {
                        issues.push({
                            code: 'weights-missing-chapter',
                            severity: 'warning',
                            message: `weights.json (${version}/${dSlug}): chapter "${rc}" exists on disk but missing from weights.json.`,
                        });
                    }
                }
            }
        }
    }

    return issues;
}

function stripPrefix(name: string): string {
    return name.replace(/^\d+-/, '');
}

/**
 * For a version, scan public/ buckets across all languages and return
 * Map<doctypeFolder, Set<chapterFolder>>.
 */
function collectDoctypeChapters(
    app: App,
    version: string,
    structure: StructureConfig,
): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    const multilang = hasLanguages(structure);
    const langsToScan = multilang ? structure.languages : [''];

    for (const lang of langsToScan) {
        const parts: string[] = [version];
        if (lang) parts.push(lang);
        parts.push(structure.publicBucket);
        const root = parts.join('/');
        const folder = app.vault.getAbstractFileByPath(root);
        if (!(folder instanceof TFolder)) continue;
        for (const child of folder.children) {
            if (!(child instanceof TFolder)) continue;
            const doctypeName = child.name;
            let chSet = out.get(doctypeName);
            if (!chSet) {
                chSet = new Set();
                out.set(doctypeName, chSet);
            }
            for (const grand of child.children) {
                if (grand instanceof TFolder) chSet.add(grand.name);
            }
        }
    }
    return out;
}

/** Modal that displays integrity issues with per-issue and bulk auto-fix. */
export class IntegrityCheckModal extends Modal {
    private plugin: DocsCmsPlugin;
    private issues: IntegrityIssue[] = [];
    private busy = false;

    constructor(plugin: DocsCmsPlugin) {
        super(plugin.app);
        this.plugin = plugin;
    }

    async onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText('CMS structure integrity');
        contentEl.createEl('p', {
            text: 'Scanning…',
            cls: 'setting-item-description',
        });
        try {
            this.issues = await runIntegrityCheck(this.plugin);
            this.render();
        } catch (e) {
            contentEl.empty();
            contentEl.createEl('p', { text: `Check failed: ${e}`, cls: 'docs-cms-warning' });
        }
    }

    onClose() {
        this.contentEl.empty();
    }

    private render() {
        const { contentEl } = this;
        contentEl.empty();

        if (this.issues.length === 0) {
            contentEl.createEl('p', {
                text: '✓ Structure looks clean — no orphan files, status-bucket mismatches, or weights.json drift.',
                cls: 'docs-cms-health-empty',
            });
            const btns = contentEl.createDiv({ cls: 'docs-cms-modal-buttons' });
            const ok = btns.createEl('button', { text: 'Close', cls: 'mod-cta' });
            ok.onclick = () => this.close();
            return;
        }

        const errors = this.issues.filter((i) => i.severity === 'error').length;
        const warnings = this.issues.filter((i) => i.severity === 'warning').length;
        contentEl.createEl('p', {
            text: `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}.`,
        });

        const fixable = this.issues.filter((i) => i.fix);
        if (fixable.length > 0) {
            const bulkBtn = contentEl.createEl('button', {
                text: `Auto-fix ${fixable.length} issue${fixable.length === 1 ? '' : 's'}`,
                cls: 'docs-cms-tree-btn mod-cta',
            });
            bulkBtn.disabled = this.busy;
            bulkBtn.onclick = async () => {
                this.busy = true;
                bulkBtn.disabled = true;
                for (const i of fixable) {
                    try {
                        await i.fix?.();
                    } catch (e) {
                        new Notice(`Fix failed for ${i.file ?? '?'}: ${e}`);
                    }
                }
                new Notice(`Auto-fixed ${fixable.length} issue${fixable.length === 1 ? '' : 's'}`);
                this.busy = false;
                // Re-scan
                this.issues = await runIntegrityCheck(this.plugin);
                this.render();
            };
        }

        const list = contentEl.createEl('ul', { cls: 'docs-cms-health-list' });
        for (const issue of this.issues) {
            const li = list.createEl('li');
            const sev = li.createSpan({
                cls: `docs-cms-integrity-sev sev-${issue.severity}`,
                text: issue.severity.toUpperCase(),
            });
            sev.style.marginRight = '6px';
            li.createSpan({ text: ` [${issue.code}] ` });
            if (issue.file) {
                const link = li.createEl('a', {
                    text: issue.file,
                    cls: 'docs-cms-health-link',
                });
                link.onclick = (e) => {
                    e.preventDefault();
                    const af = this.app.vault.getAbstractFileByPath(issue.file!);
                    if (af instanceof TFile) this.app.workspace.getLeaf(false).openFile(af);
                };
                li.createEl('br');
            }
            li.createSpan({ text: issue.message });
            if (issue.fix) {
                const fixBtn = li.createEl('button', {
                    text: 'Auto-fix',
                    cls: 'docs-cms-tree-btn',
                });
                fixBtn.style.marginLeft = '8px';
                fixBtn.onclick = async () => {
                    fixBtn.disabled = true;
                    try {
                        await issue.fix?.();
                        new Notice('Fixed');
                        this.issues = await runIntegrityCheck(this.plugin);
                        this.render();
                    } catch (e) {
                        new Notice(`Fix failed: ${e}`);
                        fixBtn.disabled = false;
                    }
                };
            }
        }

        const btns = contentEl.createDiv({ cls: 'docs-cms-modal-buttons' });
        const close = btns.createEl('button', { text: 'Close' });
        close.onclick = () => this.close();
    }
}
