import { Component, MarkdownRenderer, Modal } from 'obsidian';
import type DocsCmsPlugin from './main';

/** Renders the plugin reference as native Obsidian-styled markdown. */
export class HelpModal extends Modal {
    private plugin: DocsCmsPlugin;
    private component = new Component();

    constructor(plugin: DocsCmsPlugin) {
        super(plugin.app);
        this.plugin = plugin;
    }

    async onOpen() {
        const { contentEl, titleEl, modalEl } = this;
        titleEl.setText('Docs CMS — Reference');
        modalEl.addClass('docs-cms-help-modal');

        const wrapper = contentEl.createDiv({ cls: 'docs-cms-help-content markdown-rendered' });
        this.component.load();
        await MarkdownRenderer.render(this.app, HELP_MARKDOWN, wrapper, '', this.component);
    }

    onClose() {
        this.component.unload();
        this.contentEl.empty();
    }
}

const HELP_MARKDOWN = `Quick reference for all plugin features. Plugin version: **${'PLUGIN_VERSION'}**.

## Contents

- [Getting started](#getting-started)
- [CMS Tree](#cms-tree)
- [Working with pages](#working-with-pages)
- [Versions](#versions)
- [Translations](#translations)
- [Attachments](#attachments)
- [Health & integrity](#health--integrity)
- [Source control](#source-control)
- [Settings](#settings)
- [Commands](#commands)
- [Troubleshooting](#troubleshooting)

---

## Getting started

### First time on a fresh vault

When the plugin loads on an empty vault (no \`cms.config.json\`, no markdown matching any layout), the **Setup Wizard** auto-opens. Pick:

- **Layout** — one of four:
    - \`versioned-multilang\` → \`{version}/{lang}/{bucket}/...\`
    - \`versioned-monolang\` → \`{version}/{bucket}/...\`
    - \`flat-multilang\` → \`{lang}/{bucket}/...\`
    - \`flat-monolang\` → \`{bucket}/...\`
- **Languages** (multilang only) — comma-separated codes (e.g. \`en, ru, uz\`)
- **Bucket names** — defaults \`drafts\` and \`public\`
- **Attachments folder** — default \`_shared-attachments\`, lives at vault root
- **Doctypes** — top-level frontmatter categories

Click **Create structure** — wizard scaffolds folders and writes \`cms.config.json\`.

### Existing project

The plugin reads \`cms.config.json\` on load. Missing fields fall back to defaults — your existing layout keeps working.

To change layout later, run **Set up CMS structure…** from the command palette. Re-running on a populated vault never moves or overwrites files.

---

## CMS Tree

Open via the 📖 ribbon icon or the command **Open CMS tree**.

**Toolbar** (left to right):
- **Version selector** — dropdown of detected versions
- **+** — open the **New Version** modal
- **Language selector** (multilang only) — dropdown of configured languages
- **+ Page** — open the **New Page** wizard
- **↻** — manual refresh
- **⎇ Commit · N** — switch into the commit panel (N = changed file count)
- **?** — this help

**Content** has two collapsible sections at once:
- **📝 Drafts** — flat list of files in the drafts bucket
- **📖 Public** — full doctype → chapter → page hierarchy, sorted by \`weights.json\`

### Status icons on rows

Each row has a colored stripe on the left (when git is available):
- 🟢 **green** — file is committed and clean
- 🔵 **blue** — file has uncommitted changes

Plus a status-letter badge for changed files: \`M\` (modified), \`A\` (added), \`D\` (deleted), \`R\` (renamed), \`?\` (untracked). For files in non-default frontmatter status (\`draft\`, \`deprecated\`), an extra badge is shown.

### Context menu (right-click or **⋯**)

- **Open** — open the file in the active leaf
- **Edit frontmatter** — modal form for the frontmatter contract
- **Open on site** — opens \`{siteBaseUrl}/docs/{lang}/{version}/{slug}\` in the browser (public files only)
- **Promote to public** — runs preflight, then moves draft → public
- **Demote to drafts** — moves a published file back
- **Duplicate as draft in another language…** — copies the file with translation tracking fields
- **Rename…** — rename file and (toggleable) sync the frontmatter title
- **Delete** — moves to system trash with confirmation

### Drag-and-drop weight reorder

Within the same chapter, drag a row onto another row. The dragged page lands immediately before the drop target; all weights in the chapter are renumbered \`1, 2, 3, …\` automatically.

Cross-chapter or cross-bucket DnD is rejected — use the right-click menu for those moves.

---

## Working with pages

### Create a new page

**+ Page** in the toolbar opens the wizard:
- Pick version, language, bucket, doctype, chapter folder, filename, title, weight
- Wizard generates a file with full frontmatter from your settings defaults
- For new doctypes/chapters, \`weights.json\` is patched automatically

### Edit frontmatter

Modal form for: \`doctype\`, \`chapter\`, \`weight\`, \`title\`, \`icon\`, \`appversion\`, \`date\`, \`updated\`, \`author\`, \`tags\`, \`seo.title\`, \`seo.description\`, \`status\`.

Writes via Obsidian's \`processFrontMatter()\` — preserves any other keys you may have added.

### Promote / Demote

**Promote** runs preflight checks:
- Required frontmatter fields present (\`doctype\`, \`chapter\`, \`weight\`, \`title\`, \`appversion\`)
- All \`![[…]]\` embeds resolve to files in the attachments folder
- All \`[[…]]\` wiki-links resolve to public pages in the same language
- Target path doesn't already exist

Errors block; warnings allow promote-anyway. **Demote** moves a published file back to drafts/ if the target is free.

### Duplicate to another language

Creates a copy at the same relative path in the target language (defaults to \`drafts/\`). The copy is patched with:
- \`status: draft\`
- \`source_lang\`, \`source_path\` for tracking
- \`translation_status: stale\`

---

## Versions

### Add a new version (versioned layouts only)

Click the **+** next to the version selector. Modal options:

- **New version name** — must match \`structure.versionPattern\` from config (default \`v\\d+\\.\\d+\\.\\d+\`)
- **Source version** — pick existing version to seed from, or \`(none — empty)\`
- **Copy mode**:
    - \`Empty skeleton\` — just folders, no files
    - \`Fork published pages\` — copy public/ files; drafts stay empty
    - \`Fork all files\` — copy public + drafts
- **Bump appversion** — toggle (default on); sets \`frontmatter.appversion\` in forked files to the new version (without the \`v\` prefix)

When a source is picked, \`{source}/weights.json\` is also copied to the new version.

---

## Translations

### Translation matrix

Open via the 🌐 ribbon icon or **Open translation matrix** command.

Table: rows = unique relative paths, columns = configured languages.

Cells:
- ✓ green — page exists in \`public/\`
- ⏳ yellow — page exists in \`drafts/\`
- ⚠ — page has \`translation_status: stale\` flag
- \`+\` — page is missing in this language; click to create a draft from any existing-language version

Summary header shows per-language coverage: \`{lang} N/total (pct%) · public X · draft Y\`.

---

## Attachments

### One folder for everything

All \`![[file.png]]\` embeds resolve from a **single CMS-wide folder**, configured by \`attachmentsDir\` in \`cms.config.json\` (default: \`_shared-attachments\`).

Same convention as Obsidian's "Default location for new attachments". Configure your vault's attachment folder to match — drag-drop into a note saves to the same place the engine reads.

**Filename uniqueness is required.** Each file in the attachments folder must have a globally unique basename. If two share names, the second can't be addressed via \`![[name]]\`.

### Image picker

Command **Insert attachment (image picker)** opens a modal grid of all files in the attachments folder. Search by name, click a thumbnail → \`![[filename]]\` inserted at cursor.

---

## Health & integrity

### Broken links and embeds (Health view)

🛡️ ribbon icon or **Open health view** command. Side-pane scanner finds:
- \`[[wiki-links]]\` that don't resolve to a page in the same language's public bucket
- \`![[embeds]]\` that don't resolve to a file in the attachments folder

Same-page anchors (\`[[#section]]\`) are always valid. Page-anchor links (\`[[page#section]]\`) verify the page part only.

Drafts excluded by default — toggle in Settings. Files matching skip-patterns (default: \`documentation-plan\`) are skipped — useful for templates with intentional placeholders.

### Structure integrity

Run **Verify CMS structure (integrity check)** from the command palette or settings. Checks:

1. **Orphan files** — markdown outside the expected layout
2. **Status ↔ bucket mismatches** — \`status: draft\` in public/ (auto-fix: → published), \`status: published\` in drafts/ (auto-fix: → draft)
3. **\`frontmatter.chapter\` drift** — value doesn't match the chapter folder name (auto-fix: aligns to folder)
4. **\`weights.json\` drift** — entries listed but missing on disk, or chapters on disk missing from JSON (no auto-fix; manual review)

Each issue offers a one-click \`Auto-fix\` (where safe). \`Auto-fix N issues\` button at the top fixes everything fixable in one go.

---

## Source control

### Commit panel

Click **⎇ Commit · N** in the toolbar (or **Open commit panel** command). The tree morphs into a VS-Code-style source-control panel.

Layout:
- Branch summary: \`branch ↔ origin/branch · ↑ahead ↓behind\`
- **Staged · N** section (if anything is staged) — files that will be committed
- **Changes · N** section — files not yet staged
- Commit message textarea
- **Commit · N** / **Sync ↑N** buttons

### Selective staging

Each file row has a button on the right:
- **+** in Changes → stages the file (\`git add -A -- <file>\`) → moves to Staged
- **−** in Staged → unstages (\`git reset HEAD -- <file>\`) → moves back to Changes

Section-header buttons:
- **Stage all** — stages everything in Changes
- **Unstage all** — unstages everything in Staged

A file with both staged and working changes (\`MM\`, \`AM\`, etc.) appears in **both sections** — once with the index letter, once with the working letter. Stage/unstage actions still operate on the file path.

### Commit

Disabled until message is non-empty AND something is staged. Commits ONLY what's in the index — no auto-stage. After commit, the changes list refreshes; ahead count goes up; **Sync** button appears.

### Sync (push)

Confirms (toggleable in settings) before \`git push\`. If upstream isn't configured, the first push auto-sets it on \`origin\`.

\`Auto-rebase before push\` setting (off by default) runs \`git pull --rebase\` first when upstream is ahead.

### Empty repo

For a fresh repository with no commits yet, unstage falls back from \`git reset HEAD\` to \`git rm --cached\` automatically — no manual intervention needed.

---

## Settings

\`Settings → Community plugins → Docs CMS\`. Sections:

### Engine-shared (mirrored to cms.config.json)

- **Attachments folder** — name of the single attachments directory
- **Sync to cms.config.json** button — writes plugin's value into the engine config

### Defaults for new pages

- **Default author**
- **Default appversion**
- **Default language** (multilang)
- **Site base URL** — for \`Open on site\` actions

### Git (commit panel)

- **Confirm before push** — toggle the Sync confirmation dialog
- **Auto-rebase before push** — \`git pull --rebase\` before \`git push\` when upstream is ahead

### Health check

- **Include drafts** — scan drafts/ as well as public/
- **Skip files matching** — comma-separated path substrings to ignore

### Structure

- Read-only summary of the current layout
- **Open setup wizard** button — re-run the wizard to adjust structure
- **Run integrity check** button

---

## Commands

Open the command palette (⌘P / Ctrl+P) and search:

- \`Docs CMS: Open CMS tree\`
- \`Docs CMS: Open commit panel (source control)\`
- \`Docs CMS: Open translation matrix\`
- \`Docs CMS: Open health view (broken links and embeds)\`
- \`Docs CMS: New page…\`
- \`Docs CMS: Edit frontmatter\` (active file)
- \`Docs CMS: Promote current draft to public\` (active file)
- \`Docs CMS: Open current page on site\` (active file)
- \`Docs CMS: Insert attachment (image picker)\` (in editor)
- \`Docs CMS: Set up CMS structure…\`
- \`Docs CMS: Verify CMS structure (integrity check)\`
- \`Docs CMS: Show help\`

---

## Troubleshooting

- **No git button in toolbar.** The plugin can't find the \`git\` binary in \`$PATH\`. Restart Obsidian from a terminal where \`git\` works, or add git to your system PATH.
- **Push fails with auth error.** The plugin shells out to \`git push\` — it relies on your existing SSH keys or credential helper. Configure git the way you would for the command line.
- **All wiki-links broken in a new language.** Expected — the language's public/ bucket is empty. They'll resolve as you translate the target pages.
- **Embed resolves to wrong file or 404.** Each filename in \`_shared-attachments/\` must be globally unique. Rename to disambiguate (e.g. \`proxy_arch.png\` vs \`mcp_arch.png\`).
- **Tree shows "No CMS versions detected".** Vault has no folders matching \`structure.versionPattern\`. Run **Set up CMS structure…** to create the first version, or switch to a flat layout.

---

*Plugin lives at \`<vault>/.obsidian/plugins/docs-cms/\`. To extract into its own repo for distribution, see the README inside the plugin folder.*
`;
