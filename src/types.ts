// Shared types for the Docs CMS Obsidian plugin.

export type Doctype = 'index' | 'learn' | 'developer' | 'administrator';
export type Status = 'draft' | 'published' | 'deprecated';

export interface DocFrontmatter {
    doctype?: Doctype;
    chapter?: string;
    weight?: number;
    title?: string;
    icon?: string;
    appversion?: string;
    date?: string;
    updated?: string;
    author?: string;
    tags?: string[];
    seo?: {
        title?: string;
        description?: string;
    };
    status?: Status;
}

export interface PreflightIssue {
    severity: 'error' | 'warning';
    message: string;
}

export interface BrokenRef {
    file: string;
    line: number;
    target: string;
    kind: 'wiki-link' | 'embed';
}
