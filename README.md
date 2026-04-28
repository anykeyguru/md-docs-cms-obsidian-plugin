# Docs CMS — Obsidian plugin

[![CI](https://github.com/anykeyguru/md-docs-cms-obsidian-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/anykeyguru/md-docs-cms-obsidian-plugin/actions/workflows/ci.yml)
[![Release](https://github.com/anykeyguru/md-docs-cms-obsidian-plugin/actions/workflows/release.yml/badge.svg)](https://github.com/anykeyguru/md-docs-cms-obsidian-plugin/actions/workflows/release.yml)

Turn Obsidian into a real CMS for docs-as-code repositories: visual tree with both drafts and public side-by-side, drag-and-drop weight reordering, translation matrix, image picker, draft promotion with preflight, frontmatter form, broken-link health check, VS-Code-style commit / sync panel, schema-driven layout configurable per project, first-run setup wizard, structure-integrity checker with auto-fix, and a settings panel for engine config.

## Install

### Via BRAT (recommended)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) is a community Obsidian plugin that pulls plugins straight from GitHub repos and keeps them updated.

1. Install **Obsidian42 - BRAT** from `Settings → Community plugins → Browse`.
2. Enable BRAT, open its settings → **Add Beta plugin**.
3. Paste the repo URL: \`https://github.com/anykeyguru/md-docs-cms-obsidian-plugin\`.
4. BRAT downloads the latest release into \`<vault>/.obsidian/plugins/md-docs-cms-obsidian-plugin/\` and lists it under installed plugins.
5. \`Settings → Community plugins → Reload plugins\` → toggle **Docs CMS** on.

To get future updates: BRAT settings → **Check for updates to all beta plugins**.

### Manual install

Download the three runtime files from a [GitHub Release](https://github.com/anykeyguru/md-docs-cms-obsidian-plugin/releases): \`manifest.json\`, \`main.js\`, \`styles.css\`. Drop them into:

\`\`\`
<vault>/.obsidian/plugins/docs-cms/
\`\`\`

(Folder name doesn't have to match the repo — Obsidian uses \`manifest.json\`'s \`id\` field, which is \`docs-cms\`.) Then in Obsidian: **Reload plugins** → enable.

## First run

On a vault with no existing \`cms.config.json\` and no markdown matching any known layout, the **Setup Wizard** auto-opens on first plugin load. Pick a layout, languages, bucket names — wizard scaffolds folders and writes \`cms.config.json\`. See [Portability](#portability) below for details on what's configurable.

## Portability

The vault layout is **not hardcoded**. The plugin reads it from `cms.config.json`:

```json
{
  "attachmentsDir": "_shared-attachments",
  "structure": {
    "layout": "versioned-multilang",
    "versionPattern": "v\\d+\\.\\d+\\.\\d+",
    "languages": ["en", "ru", "uz"],
    "buckets": ["drafts", "public"],
    "publicBucket": "public",
    "draftsBucket": "drafts",
    "doctypes": ["index", "learn", "developer", "administrator"]
  },
  "frontmatter": {
    "required": ["doctype", "chapter", "weight", "title", "appversion"],
    "defaults": {}
  }
}
```

Four pre-defined layouts cover the common cases:

- `versioned-multilang` — `{version}/{language}/{bucket}/…` (your current setup)
- `versioned-monolang` — `{version}/{bucket}/…`
- `flat-multilang` — `{language}/{bucket}/…`
- `flat-monolang` — `{bucket}/…`

Open another project, install the plugin, run `Docs CMS: Set up CMS structure…` from the command palette — the wizard scaffolds folders and writes the config. Re-runnable any time on a populated vault to adjust settings without moving files.

For an **empty vault** (no `cms.config.json` and no markdown matching any known layout), the wizard auto-opens on first plugin load.

## Integrity

Run `Docs CMS: Verify CMS structure (integrity check)` (or click the button in Settings) to scan for:

1. **Orphan files** — markdown outside the expected layout.
2. **Status ↔ bucket mismatches** — `status: draft` in `public/` (won't render on the site!) or `status: published` in `drafts/`.
3. **`frontmatter.chapter` drift** — value doesn't match the chapter folder name.
4. **`weights.json` drift** — doctypes/chapters listed in `weights.json` that don't exist on disk, or chapters on disk missing from `weights.json`.

Each issue offers a one-click `Auto-fix` (where safe). A bulk `Auto-fix N issues` button at the top fixes everything fixable.

## What it gives you

### CMS Tree view (left sidebar — 📖 ribbon icon)

A panel mirroring the rendered docs site. Pick **Version** and **Language** at the top — below you see two collapsible sections:

- **📝 Drafts** — flat list of files awaiting promotion. Right-click a draft → **Promote to public**.
- **📖 Public** — full doctype → chapter → page hierarchy, sorted by `cms/{version}/weights.json` (same order as the rendered site).

Click any page to open it. Hover → `⋯` button appears for actions. Right-click also opens the menu.

**Per-page actions:**

- Open
- Edit frontmatter (modal form)
- **Open on site** — opens `http://localhost:3001/docs/{lang}/{version}/{slug}` (URL configurable in settings; public files only)
- **Promote to public** (drafts only) — preflight checks before move
- **Demote to drafts** (public only)
- Duplicate as draft in another language… — auto-fills `source_lang`, `source_path`, `translation_status: stale`
- Rename… — renames file + (optionally) syncs `frontmatter.title`
- Delete (move to system trash)

**Drag-and-drop weight reorder.** Within a chapter, drag a page row onto another page — the dragged page lands immediately before the drop target, and all pages in the chapter are renumbered to consecutive integers (`weight: 1, 2, 3, …`). Cross-chapter / cross-bucket DnD is intentionally rejected — use the right-click menu for those moves to avoid accidents.

**Git changed-dot.** Pages with uncommitted changes get a small `●` indicator next to their title.

### Commit panel (Source Control)

Click the **⎇ Commit · N** button in the tree toolbar (the count is the number of changed files). The whole tree morphs into a VS-Code-style source-control panel:

- Branch summary (`main ↔ origin/main · ↑3 ↓0`)
- Changes grouped by kind: Modified, Added, Deleted, Renamed, Untracked. Each row clickable to open the file.
- Commit message textarea (focused automatically).
- **Commit** button — runs `git add -A -- <files>` then `git commit -m "<message>"`. Disabled until message non-empty.
- **Sync** button — appears when there are commits to push or pull. Confirms (toggle in settings), optionally `git pull --rebase` first (toggle), then `git push`. Auto-sets upstream on first push.
- **Fetch** button — `git fetch --prune` to refresh ahead/behind counts.
- **← Cancel** — back to browse mode without changing state.

After a successful commit the panel stays in commit-mode; the changes list empties, the Sync button becomes available with the new ahead count.

### Translation matrix view (main pane — 🌐 ribbon icon)

A full table: rows are unique relative paths within a version, columns are languages (en/ru/uz). Cells:

- ✓ green — page exists in `public/`
- ⏳ yellow — page exists in `drafts/`
- ⚠ — `translation_status: stale` flag
- `+` button — page is missing in this language; click to create a draft by copying from any existing-language version

A summary header shows per-language coverage (`22/22 (100%) · public 22 · draft 0`).

### Image picker (command — `Insert attachment`)

While editing a markdown file, run `Docs CMS: Insert attachment (image picker)` — a modal opens with a thumbnail grid of every file in `_shared-attachments/`, plus a search box. Click a thumb → inserts `![[filename]]` at the cursor.

### Health view (right sidebar — 🛡️ ribbon icon)

Vault-wide scan for broken `[[wiki-links]]` and `![[embeds]]`, grouped by file, click-to-jump to the offending line.

- Wiki-link resolution is language-scoped against `public/` (matches the renderer).
- Embed resolution checks the configured attachments folder.
- Same-page anchors `[[#section]]` and page-anchor links `[[page#section]]` are recognized as valid.
- Drafts excluded by default (toggle in Settings → Health check → Include drafts).
- Files matching configured substrings (default: `documentation-plan`) are skipped.

### New page wizard (`+ Page` button or command)

Asks for version, language, bucket, doctype, chapter folder, filename, title, weight. Generates a file with full frontmatter from your settings defaults. **Auto-patches `weights.json`** when you create a page in a brand-new chapter or doctype, so the rendered site picks it up without manual editing.

### Settings tab

`Settings → Community plugins → Docs CMS`. Three sections:

1. **Engine-shared** — `attachmentsDir` (single folder for `![[…]]` embeds). The "Sync to cms.config.json" button mirrors the value to `cms/cms.config.json` (which the Next.js renderer reads). Plugin and engine stay aligned.
2. **Defaults for new pages** — author, appversion, default language, **site base URL** (used by "Open on site").
3. **Health check** — include-drafts toggle, comma-separated skip patterns.

On startup the plugin reads `cms/cms.config.json` and adopts its `attachmentsDir` automatically.

## Enable in Obsidian

1. Open Obsidian on the `cms/` vault.
2. `Settings → Community plugins → Turn on community plugins` (turn off Restricted Mode the first time).
3. Click `Reload plugins` (the circular arrow next to the search box).
4. In Installed plugins find **Docs CMS** and toggle it on.

You'll see three new ribbon icons: 📖 **CMS tree**, 🌐 **translation matrix**, 🛡️ **health check**.

## Per-vault state

Each vault is independent — installing the same plugin in two vaults doesn't share state:

- \`<vault-root>/cms.config.json\` — structure (layout, languages, buckets, doctypes, attachmentsDir). One per vault.
- \`<vault-root>/.obsidian/plugins/docs-cms/data.json\` — plugin settings (default author, site URL, git toggles). One per vault. Not committed to the plugin repo.
- \`<vault-root>/.git\` — each vault's git repo is its own; the commit panel reads only the local repo.

## Commands (⌘P)

- `Docs CMS: Open CMS tree`
- `Docs CMS: Open commit panel (source control)` — same view, switched into commit mode
- `Docs CMS: Open translation matrix`
- `Docs CMS: Set up CMS structure…` — re-runnable scaffold wizard
- `Docs CMS: Verify CMS structure (integrity check)`
- `Docs CMS: New page…`
- `Docs CMS: Edit frontmatter` (acts on active file)
- `Docs CMS: Promote current draft to public` (acts on active file)
- `Docs CMS: Open current page on site` (acts on active public file)
- `Docs CMS: Insert attachment (image picker)` (in editor)
- `Docs CMS: Open health view (broken links and embeds)`

## Develop

```bash
git clone git@github.com:anykeyguru/md-docs-cms-obsidian-plugin.git
cd md-docs-cms-obsidian-plugin
npm install              # one-time
npm run dev              # esbuild --watch, recompiles main.js on save
# OR
npm run build            # one-shot production build (minified)
```

To work against a real Obsidian vault, symlink the cloned repo into the vault's plugins folder:

```bash
ln -s "$(pwd)" "<vault>/.obsidian/plugins/docs-cms"
```

With `npm run dev` running in the clone, edit any file in `src/` and reload the plugin in Obsidian (`⌘P → Reload app without saving`, or toggle the plugin off/on in settings).

## Release process

Releases are produced by `.github/workflows/release.yml` when a `v*.*.*` tag is pushed:

```bash
# 1. Bump versions
npm version 0.5.6 --no-git-tag-version       # updates package.json
# manually update manifest.json + versions.json to match

# 2. Commit + tag + push
git add manifest.json versions.json package.json
git commit -m "release v0.5.6"
git tag v0.5.6
git push origin main --tags
```

GitHub Actions then:
1. Verifies `manifest.json`'s `version` matches the tag
2. Runs `npm ci && npm run build`
3. Creates a GitHub Release with `manifest.json`, `main.js`, `styles.css` as assets
4. BRAT users get the update via "Check for updates"

There's a `package.sh` in the repo that also produces a local `dist/docs-cms-<version>.zip` for manual install — useful when you want to test a build before tagging.

## Layout

```
docs-cms/
├── manifest.json                 # Obsidian plugin manifest
├── package.json                  # build deps
├── tsconfig.json
├── esbuild.config.mjs            # bundles src/main.ts → main.js
├── styles.css                    # plugin DOM styles
├── main.js                       # compiled bundle (committed)
└── src/
    ├── main.ts                   # Plugin class, command + view + ribbon registration
    ├── settings.ts               # PluginSettingTab + cms.config.json sync
    ├── paths.ts                  # vault path parsing
    ├── types.ts                  # DocFrontmatter, PreflightIssue, BrokenRef
    ├── weights.ts                # read/write cms/{version}/weights.json
    ├── frontmatter-form.ts       # Edit-frontmatter modal
    ├── new-page-modal.ts         # New page wizard (patches weights.json)
    ├── promote.ts                # preflight + promote/demote moves
    ├── page-actions.ts           # tree row context menu (Open on site, rename, delete, duplicate-to-language)
    ├── health-check.ts           # vault scanner for broken refs
    ├── health-view.ts            # right-pane ItemView (broken refs)
    ├── cms-tree-view.ts          # left-pane ItemView (the CMS tree, both buckets, DnD)
    ├── translation-matrix-view.ts # main-pane ItemView (cross-language table)
    └── image-picker-modal.ts     # modal grid for inserting ![[…]] embeds
```

## Roadmap

- v0.4: cross-chapter and cross-bucket drag-and-drop with confirmation; "promote bundle" — promote a draft + all its draft dependencies in one go.
- v0.5: live preview pane that uses the same MDX pipeline as the Next.js renderer; visual indicator for translation drift (compare source_hash).
- v0.6: extract to its own repo (`obsidian-docs-cms-plugin/`) with releases, install via BRAT.

## Known limitations (v0.3)

- DnD reordering is in-chapter only. Cross-chapter / cross-bucket moves go through the right-click menu.
- "Rename" updates filename + frontmatter title, but does not update incoming `[[wiki-links]]` from other files (Obsidian's native auto-update handles backlinks for path changes, not for title-as-display-text — alias users may need to refresh manually).
- `weights.json` patching only **adds** new doctype/chapter entries; it never removes or reorders existing ones.
- Translation matrix groups by relative path; if the same logical page lives at different paths in different languages, it shows as separate rows.
