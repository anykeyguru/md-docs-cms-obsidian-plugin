import { App, Notice, TFile, TFolder, normalizePath } from 'obsidian';
import { parseDocPath, publicPathFor, draftsPathFor } from './paths';
import { DocFrontmatter, PreflightIssue } from './types';

const REQUIRED_FRONTMATTER_FIELDS: (keyof DocFrontmatter)[] = [
    'doctype', 'chapter', 'weight', 'title', 'appversion',
];

const EMBED_REGEX = /!\[\[([^\]]+)\]\]/g;
const LINK_REGEX = /(?<!!)\[\[([^\]]+)\]\]/g;

export interface PreflightContext {
    attachmentsDir: string;
}

/**
 * Run all preflight checks for a draft → public promotion.
 * Returns a list of issues; empty list means safe to promote.
 */
export async function preflight(app: App, file: TFile, ctx: PreflightContext): Promise<PreflightIssue[]> {
    const issues: PreflightIssue[] = [];
    const parsed = parseDocPath(file.path);

    if (!parsed) {
        issues.push({
            severity: 'error',
            message: `Path "${file.path}" is not under v*/{en|ru|uz}/{drafts|public}/...`,
        });
        return issues;
    }
    if (!parsed.isDrafts) {
        issues.push({
            severity: 'error',
            message: `File is in "${parsed.bucket}/", not in drafts/ — nothing to promote.`,
        });
        return issues;
    }

    // Required frontmatter fields
    const cache = app.metadataCache.getFileCache(file);
    const fm = (cache?.frontmatter ?? {}) as DocFrontmatter;
    for (const k of REQUIRED_FRONTMATTER_FIELDS) {
        const v = (fm as Record<string, unknown>)[k];
        if (v === undefined || v === null || v === '') {
            issues.push({ severity: 'error', message: `frontmatter.${String(k)} is missing` });
        }
    }
    if (fm.status === 'draft') {
        issues.push({
            severity: 'warning',
            message: `frontmatter.status is "draft" — site filters drafts out; consider "published".`,
        });
    }

    // Target collision
    const targetPath = normalizePath(publicPathFor(parsed));
    const existing = app.vault.getAbstractFileByPath(targetPath);
    if (existing) {
        issues.push({ severity: 'error', message: `Target already exists: ${targetPath}` });
    }

    // Reference checks
    const text = await app.vault.read(file);

    for (const m of text.matchAll(EMBED_REGEX)) {
        const filename = m[1].trim();
        const candidate = normalizePath(`${ctx.attachmentsDir}/${filename}`);
        const af = app.vault.getAbstractFileByPath(candidate);
        if (!af) {
            issues.push({
                severity: 'error',
                message: `embed broken: ![[${filename}]] — not found in ${ctx.attachmentsDir}/`,
            });
        }
    }

    const wikiLinks = [...text.matchAll(LINK_REGEX)];
    if (wikiLinks.length > 0) {
        const pageBasenames = new Set<string>();
        for (const f of app.vault.getMarkdownFiles()) {
            const p = parseDocPath(f.path);
            if (p && p.language === parsed.language && p.isPublic) {
                pageBasenames.add(f.basename.toLowerCase());
            }
        }
        for (const m of wikiLinks) {
            const raw = m[1].trim();
            const beforeAlias = (raw.split('|')[0] ?? raw).trim();
            const pagePart = (beforeAlias.split('#')[0] ?? beforeAlias).trim().toLowerCase();
            if (!pagePart) continue; // same-page anchor — always valid
            if (!pageBasenames.has(pagePart)) {
                issues.push({
                    severity: 'warning',
                    message: `wiki-link [[${raw}]] does not resolve to a published page in ${parsed.language}/public yet`,
                });
            }
        }
    }

    return issues;
}

/** Move a draft into public/. Caller should run preflight first. */
export async function promote(app: App, file: TFile): Promise<string | null> {
    const parsed = parseDocPath(file.path);
    if (!parsed || !parsed.isDrafts) {
        new Notice('Not a draft file — nothing to promote');
        return null;
    }
    const targetPath = normalizePath(publicPathFor(parsed));
    await ensureFolder(app, targetPath);
    await app.fileManager.renameFile(file, targetPath);
    new Notice(`Promoted → ${targetPath}`);
    return targetPath;
}

/** Move a published file back into drafts/. */
export async function demoteToDrafts(app: App, file: TFile): Promise<string | null> {
    const parsed = parseDocPath(file.path);
    if (!parsed || !parsed.isPublic) {
        new Notice('Not a published file — nothing to demote');
        return null;
    }
    const targetPath = normalizePath(draftsPathFor(parsed));
    const existing = app.vault.getAbstractFileByPath(targetPath);
    if (existing) {
        new Notice(`Cannot demote: ${targetPath} already exists`);
        return null;
    }
    await ensureFolder(app, targetPath);
    await app.fileManager.renameFile(file, targetPath);
    new Notice(`Demoted → ${targetPath}`);
    return targetPath;
}

export async function ensureFolder(app: App, filePath: string): Promise<void> {
    const dir = filePath.split('/').slice(0, -1).join('/');
    if (!dir) return;
    const af = app.vault.getAbstractFileByPath(dir);
    if (af instanceof TFolder) return;
    if (af) {
        throw new Error(`Target parent path "${dir}" exists but is not a folder`);
    }
    await app.vault.createFolder(dir);
}
