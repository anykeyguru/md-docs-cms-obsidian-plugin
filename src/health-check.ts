import { App, TFolder } from 'obsidian';
import { parseDocPath } from './paths';
import { BrokenRef } from './types';

const EMBED_REGEX = /!\[\[([^\]]+)\]\]/g;
const LINK_REGEX = /(?<!!)\[\[([^\]]+)\]\]/g;

export interface HealthOptions {
    attachmentsDir: string;
    /** When false, files under `drafts/` are skipped. */
    includeDrafts: boolean;
    /** Substrings; any file path containing one of these is skipped. */
    skipPathPatterns: string[];
}

/**
 * Walk every markdown file in the vault and report `[[wiki-links]]` and
 * `![[embeds]]` that don't resolve.
 *
 * Resolution rules (mirror the Next.js renderer):
 * - Embeds resolve to a basename under `cms/{attachmentsDir}/`.
 * - Wiki-links resolve to a markdown basename within the same language's
 *   `public/` bucket. Same-page anchors (`[[#section]]`) are always valid.
 */
export async function runHealthCheck(app: App, opts: HealthOptions): Promise<BrokenRef[]> {
    const issues: BrokenRef[] = [];

    // Step 1. Index attachment basenames
    const assets = new Set<string>();
    const attachFolder = app.vault.getAbstractFileByPath(opts.attachmentsDir);
    if (attachFolder instanceof TFolder) {
        for (const child of attachFolder.children) {
            assets.add(child.name);
        }
    }

    // Step 2. Index page basenames per language (public only)
    const pagesByLang = new Map<string, Set<string>>();
    for (const f of app.vault.getMarkdownFiles()) {
        const p = parseDocPath(f.path);
        if (!p || !p.isPublic) continue;
        const langKey = p.language ?? '__nolang__';
        let set = pagesByLang.get(langKey);
        if (!set) {
            set = new Set();
            pagesByLang.set(langKey, set);
        }
        set.add(f.basename.toLowerCase());
    }

    // Step 3. Scan every doc file for refs
    for (const f of app.vault.getMarkdownFiles()) {
        const p = parseDocPath(f.path);
        if (!p) continue;
        if (!opts.includeDrafts && p.isDrafts) continue;
        if (opts.skipPathPatterns.some((pat) => f.path.includes(pat))) continue;

        const text = await app.vault.cachedRead(f);
        const lines = text.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            for (const m of line.matchAll(EMBED_REGEX)) {
                const filename = m[1].trim();
                if (!assets.has(filename)) {
                    issues.push({
                        file: f.path,
                        line: i + 1,
                        target: filename,
                        kind: 'embed',
                    });
                }
            }

            for (const m of line.matchAll(LINK_REGEX)) {
                const raw = m[1].trim();
                const pagePart = parseWikiTarget(raw);
                if (pagePart === null) continue; // same-page anchor — valid by construction

                const langKey = p.language ?? '__nolang__';
                const langPages = pagesByLang.get(langKey);
                if (!langPages || !langPages.has(pagePart)) {
                    issues.push({
                        file: f.path,
                        line: i + 1,
                        target: raw,
                        kind: 'wiki-link',
                    });
                }
            }
        }
    }

    return issues;
}

/**
 * Extract the lowercased page basename from a wiki-link target.
 * Returns null for same-page anchor links like `#section`, which are always
 * considered valid (we don't currently verify heading existence).
 */
function parseWikiTarget(raw: string): string | null {
    const beforeAlias = (raw.split('|')[0] ?? raw).trim();
    const beforeAnchor = (beforeAlias.split('#')[0] ?? beforeAlias).trim();
    if (!beforeAnchor) return null;
    return beforeAnchor.toLowerCase();
}
