import { App, TFile } from 'obsidian';

/** One of four pre-defined vault layouts. */
export type Layout =
    | 'versioned-multilang'   // {version}/{lang}/{bucket}/{relPath}
    | 'versioned-monolang'    // {version}/{bucket}/{relPath}
    | 'flat-multilang'        // {lang}/{bucket}/{relPath}
    | 'flat-monolang';        // {bucket}/{relPath}

/** Describes the on-disk structure of the docs vault. */
export interface StructureConfig {
    layout: Layout;
    /** Regex source matching version directory names. Only used for `versioned-*` layouts. */
    versionPattern: string;
    /** Allowed language codes. Empty for `*-monolang`. Used for dropdowns and parsing. */
    languages: string[];
    /** Bucket directory names. Must contain at least `publicBucket` and `draftsBucket`. */
    buckets: string[];
    /** Bucket whose files are rendered on the site. */
    publicBucket: string;
    /** Bucket where work-in-progress lives. */
    draftsBucket: string;
    /** Doctype values used for grouping and the New Page wizard dropdown. */
    doctypes: string[];
}

/** Frontmatter contract enforced by the plugin. */
export interface FrontmatterConfig {
    /** Field names required for promotion to public. */
    required: string[];
    /** Pre-filled values when creating a new page. */
    defaults: Record<string, unknown>;
}

/** Top-level engine config — single source of truth, lives at `cms/cms.config.json`. */
export interface CmsConfig {
    /** Folder under vault root where ALL `![[…]]` embeds resolve. */
    attachmentsDir: string;
    structure: StructureConfig;
    frontmatter: FrontmatterConfig;
}

export const DEFAULT_STRUCTURE: StructureConfig = {
    layout: 'versioned-multilang',
    versionPattern: 'v\\d+\\.\\d+\\.\\d+',
    languages: ['en', 'ru', 'uz'],
    buckets: ['drafts', 'public'],
    publicBucket: 'public',
    draftsBucket: 'drafts',
    doctypes: ['index', 'learn', 'developer', 'administrator'],
};

export const DEFAULT_FRONTMATTER: FrontmatterConfig = {
    required: ['doctype', 'chapter', 'weight', 'title', 'appversion'],
    defaults: {},
};

export const DEFAULT_CONFIG: CmsConfig = {
    attachmentsDir: '_shared-attachments',
    structure: DEFAULT_STRUCTURE,
    frontmatter: DEFAULT_FRONTMATTER,
};

export const CMS_CONFIG_PATH = 'cms.config.json';

/** Path is versioned under this layout. */
export function isVersioned(s: StructureConfig): boolean {
    return s.layout === 'versioned-multilang' || s.layout === 'versioned-monolang';
}

/** Path includes a language segment under this layout. */
export function hasLanguages(s: StructureConfig): boolean {
    return s.layout === 'versioned-multilang' || s.layout === 'flat-multilang';
}

interface RawCmsConfig {
    attachmentsDir?: string;
    structure?: Partial<StructureConfig>;
    frontmatter?: Partial<FrontmatterConfig>;
    [k: string]: unknown;
}

/** Read raw JSON from disk; null if missing/invalid. */
async function readRaw(app: App): Promise<RawCmsConfig | null> {
    const af = app.vault.getAbstractFileByPath(CMS_CONFIG_PATH);
    if (!(af instanceof TFile)) return null;
    try {
        return JSON.parse(await app.vault.read(af)) as RawCmsConfig;
    } catch {
        return null;
    }
}

/** Read merged config, applying defaults for any missing fields. */
export async function loadCmsConfig(app: App): Promise<CmsConfig> {
    const raw = (await readRaw(app)) ?? {};
    return {
        attachmentsDir: typeof raw.attachmentsDir === 'string' && raw.attachmentsDir
            ? raw.attachmentsDir
            : DEFAULT_CONFIG.attachmentsDir,
        structure: { ...DEFAULT_STRUCTURE, ...(raw.structure ?? {}) },
        frontmatter: { ...DEFAULT_FRONTMATTER, ...(raw.frontmatter ?? {}) },
    };
}

/**
 * Write a partial patch into cms.config.json, preserving any unmanaged keys
 * the renderer or other tools might add later.
 */
export async function writeCmsConfig(app: App, patch: Partial<CmsConfig>): Promise<void> {
    const existing = (await readRaw(app)) ?? {};
    const merged: RawCmsConfig = {
        '$schema-comment': 'CMS-wide engine config. Edited by the docs-cms Obsidian plugin and read by src/lib/cms-config.ts.',
        ...existing,
        ...patch,
    };
    const json = JSON.stringify(merged, null, 2) + '\n';
    const af = app.vault.getAbstractFileByPath(CMS_CONFIG_PATH);
    if (af instanceof TFile) {
        await app.vault.modify(af, json);
    } else {
        await app.vault.create(CMS_CONFIG_PATH, json);
    }
}

/**
 * Convenience for the legacy code path where only `attachmentsDir` is being
 * read. Kept as a thin shim so existing callers don't all have to change.
 */
export async function readCmsConfig(app: App): Promise<{ attachmentsDir?: string } | null> {
    const raw = await readRaw(app);
    if (!raw) return null;
    return { attachmentsDir: typeof raw.attachmentsDir === 'string' ? raw.attachmentsDir : undefined };
}
