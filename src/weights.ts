import { App, TFile, normalizePath } from 'obsidian';

/**
 * Shape of cms/{version}/weights.json — controls the rendered site's sidebar order.
 *   doctype_weight: { learn: 1, administrator: 2, ... }
 *   chapter_weight: { learn: { proxy: 1, "Message Control Protocol": 5 } }
 */
export interface WeightsJson {
    doctype_weight?: Record<string, number>;
    chapter_weight?: Record<string, Record<string, number>>;
}

/** Folder/file names like `01-learn` → `learn`, `03-creating-campaign` → `creating-campaign`. */
export function stripNumericPrefix(name: string): string {
    return name.replace(/^\d+-/, '');
}

export function weightsPath(version: string): string {
    return normalizePath(`${version}/weights.json`);
}

export async function readWeights(app: App, version: string): Promise<WeightsJson> {
    const af = app.vault.getAbstractFileByPath(weightsPath(version));
    if (!(af instanceof TFile)) return {};
    try {
        return JSON.parse(await app.vault.read(af)) as WeightsJson;
    } catch {
        return {};
    }
}

export async function writeWeights(app: App, version: string, w: WeightsJson): Promise<void> {
    const path = weightsPath(version);
    const json = JSON.stringify(w, null, 2) + '\n';
    const af = app.vault.getAbstractFileByPath(path);
    if (af instanceof TFile) {
        await app.vault.modify(af, json);
    } else {
        await app.vault.create(path, json);
    }
}

/**
 * Look up doctype weight by folder name (e.g. "01-learn"). Returns Infinity if
 * not present in weights.json — falls back to numeric-prefix sort downstream.
 */
export function doctypeWeight(w: WeightsJson, folderName: string): number {
    const slug = stripNumericPrefix(folderName);
    const v = w.doctype_weight?.[slug];
    return typeof v === 'number' ? v : Number.POSITIVE_INFINITY;
}

export function chapterWeight(w: WeightsJson, doctypeFolder: string, chapterFolder: string): number {
    const dSlug = stripNumericPrefix(doctypeFolder);
    const cSlug = stripNumericPrefix(chapterFolder);
    const v = w.chapter_weight?.[dSlug]?.[cSlug];
    return typeof v === 'number' ? v : Number.POSITIVE_INFINITY;
}

/**
 * Stable comparator for folder names: weights.json first (lower wins),
 * then numeric prefix, then alphabetical.
 */
export function compareDoctypes(w: WeightsJson) {
    return (a: string, b: string) => {
        const wa = doctypeWeight(w, a);
        const wb = doctypeWeight(w, b);
        if (wa !== wb) return wa - wb;
        return numericPrefixOrAlpha(a, b);
    };
}

export function compareChapters(w: WeightsJson, doctypeFolder: string) {
    return (a: string, b: string) => {
        const wa = chapterWeight(w, doctypeFolder, a);
        const wb = chapterWeight(w, doctypeFolder, b);
        if (wa !== wb) return wa - wb;
        return numericPrefixOrAlpha(a, b);
    };
}

function numericPrefixOrAlpha(a: string, b: string): number {
    const pa = parseInt(a.match(/^(\d+)-/)?.[1] ?? '', 10);
    const pb = parseInt(b.match(/^(\d+)-/)?.[1] ?? '', 10);
    if (Number.isFinite(pa) && Number.isFinite(pb) && pa !== pb) return pa - pb;
    return a.localeCompare(b);
}

/**
 * Patch weights.json: ensure a doctype slug has a weight (assigned as max+1 if absent).
 * Returns true if the file was modified.
 */
export async function ensureDoctypeWeight(app: App, version: string, doctypeFolder: string): Promise<boolean> {
    const w = await readWeights(app, version);
    const slug = stripNumericPrefix(doctypeFolder);
    if (w.doctype_weight && slug in w.doctype_weight) return false;
    if (!w.doctype_weight) w.doctype_weight = {};
    const maxExisting = Math.max(0, ...Object.values(w.doctype_weight));
    w.doctype_weight[slug] = maxExisting + 1;
    await writeWeights(app, version, w);
    return true;
}

/**
 * Patch weights.json: ensure a (doctype, chapter) pair has a weight (max+1 if absent).
 * Returns true if the file was modified.
 */
export async function ensureChapterWeight(
    app: App,
    version: string,
    doctypeFolder: string,
    chapterFolder: string,
): Promise<boolean> {
    const w = await readWeights(app, version);
    const dSlug = stripNumericPrefix(doctypeFolder);
    const cSlug = stripNumericPrefix(chapterFolder);
    if (!w.chapter_weight) w.chapter_weight = {};
    if (!w.chapter_weight[dSlug]) w.chapter_weight[dSlug] = {};
    if (cSlug in w.chapter_weight[dSlug]) return false;
    const maxExisting = Math.max(0, ...Object.values(w.chapter_weight[dSlug]));
    w.chapter_weight[dSlug][cSlug] = maxExisting + 1;
    await writeWeights(app, version, w);
    return true;
}
