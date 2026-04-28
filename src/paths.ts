// Vault path parsing — schema-driven.
//
// On plugin startup we call `initPathSchema(structure)` once with the merged
// CmsConfig.structure. After that, free functions `parseDocPath()` and
// `bucketPath()` use the cached PathSchema to avoid threading config through
// every call site.

import { hasLanguages, isVersioned, StructureConfig } from './cms-config';

export type Language = string;
export type Bucket = string;

export interface ParsedPath {
    /** Version directory name, e.g. "v1.0.0". `null` if the layout has no version segment. */
    version: string | null;
    /** Language directory name. `null` if the layout has no language segment. */
    language: string | null;
    /** Bucket directory name (one of structure.buckets). */
    bucket: string;
    /** Path relative to the bucket — e.g. "01-learn/01-proxy/01-proxy.md". */
    relPath: string;

    /** Convenience: bucket === structure.publicBucket. */
    isPublic: boolean;
    /** Convenience: bucket === structure.draftsBucket. */
    isDrafts: boolean;
}

class PathSchema {
    public readonly regex: RegExp;
    public readonly structure: StructureConfig;
    private readonly versioned: boolean;
    private readonly multilang: boolean;

    constructor(structure: StructureConfig) {
        this.structure = structure;
        this.versioned = isVersioned(structure);
        this.multilang = hasLanguages(structure);

        // Build a regex that captures the segments we need.
        // Each segment is followed by a literal "/" except the last (relPath).
        const segments: string[] = [];
        if (this.versioned) segments.push(`(${structure.versionPattern})`);
        if (this.multilang) {
            const langs = structure.languages.length > 0
                ? structure.languages.map(escapeRegex).join('|')
                : '[^/]+';
            segments.push(`(${langs})`);
        }
        const buckets = structure.buckets.length > 0
            ? structure.buckets.map(escapeRegex).join('|')
            : '[^/]+';
        segments.push(`(${buckets})`);
        // Final group is the relative path (anything, including subdirs)
        segments.push(`(.*)`);

        this.regex = new RegExp(`^${segments.join('\\/')}$`);
    }

    parse(path: string): ParsedPath | null {
        const m = this.regex.exec(path);
        if (!m) return null;
        let i = 1;
        const version = this.versioned ? m[i++] : null;
        const language = this.multilang ? m[i++] : null;
        const bucket = m[i++];
        const relPath = m[i++];
        return {
            version,
            language,
            bucket,
            relPath,
            isPublic: bucket === this.structure.publicBucket,
            isDrafts: bucket === this.structure.draftsBucket,
        };
    }

    build(version: string | null, language: string | null, bucket: string, relPath: string): string {
        const parts: string[] = [];
        if (this.versioned) {
            if (!version) throw new Error('version is required for the configured layout');
            parts.push(version);
        }
        if (this.multilang) {
            if (!language) throw new Error('language is required for the configured layout');
            parts.push(language);
        }
        parts.push(bucket);
        parts.push(relPath);
        return parts.join('/');
    }

    bucketRoot(version: string | null, language: string | null, bucket: string): string {
        return this.build(version, language, bucket, '').replace(/\/$/, '');
    }
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let SCHEMA: PathSchema | null = null;

export function initPathSchema(structure: StructureConfig): void {
    SCHEMA = new PathSchema(structure);
}

export function getPathSchema(): PathSchema {
    if (!SCHEMA) throw new Error('PathSchema not initialized — call initPathSchema first');
    return SCHEMA;
}

// ── Public API ───────────────────────────────────────────────────────────────

export function parseDocPath(vaultRelPath: string): ParsedPath | null {
    return getPathSchema().parse(vaultRelPath);
}

export function bucketPath(version: string | null, language: string | null, bucket: string, relPath: string): string {
    return getPathSchema().build(version, language, bucket, relPath);
}

export function publicPathFor(parsed: ParsedPath): string {
    return getPathSchema().build(parsed.version, parsed.language, getPathSchema().structure.publicBucket, parsed.relPath);
}

export function draftsPathFor(parsed: ParsedPath): string {
    return getPathSchema().build(parsed.version, parsed.language, getPathSchema().structure.draftsBucket, parsed.relPath);
}

export function bucketRoot(version: string | null, language: string | null, bucket: string): string {
    return getPathSchema().bucketRoot(version, language, bucket);
}

/** Returns true if the configured layout includes a version dimension. */
export function isLayoutVersioned(): boolean {
    return isVersioned(getPathSchema().structure);
}

/** Returns true if the configured layout includes a language dimension. */
export function isLayoutMultilang(): boolean {
    return hasLanguages(getPathSchema().structure);
}
