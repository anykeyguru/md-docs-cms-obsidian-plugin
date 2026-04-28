// Thin wrapper around the system `git` binary. We spawn it directly (no shell)
// so paths/messages can't be misinterpreted, and we capture both stdout and stderr
// for surfaced error messages.
//
// `cwd` is always the absolute path to the git repository root — the plugin
// resolves it once via `FileSystemAdapter.getBasePath()`.

import { spawn } from 'child_process';

export interface GitFile {
    /** Path relative to the repository root (vault root). */
    path: string;
    /** Index status char from `git status --porcelain` (M, A, D, R, C, ??, etc.). */
    indexStatus: string;
    /** Working-tree status char. */
    workingStatus: string;
    /** A short single-letter summary used for grouping in the UI. */
    kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'other';
}

export interface GitUpstream {
    branch: string;
    upstream: string | null;
    ahead: number;
    behind: number;
}

export interface GitResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

function runGit(cwd: string, args: string[], timeoutMs = 30_000): Promise<GitResult> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf-8')));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf-8')));
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, exitCode: code ?? 0 });
        });
    });
}

async function runGitOk(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
    const r = await runGit(cwd, args, timeoutMs);
    if (r.exitCode !== 0) {
        throw new Error(`git ${args.join(' ')} failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return r.stdout;
}

export async function isGitAvailable(cwd: string): Promise<boolean> {
    try {
        const r = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'], 5_000);
        return r.exitCode === 0 && r.stdout.trim() === 'true';
    } catch {
        return false;
    }
}

/**
 * Parse `git status --porcelain=v1 -b -uall` (untracked files included).
 * Returns the file list plus upstream info from the header line.
 */
export async function getStatusAndUpstream(cwd: string): Promise<{ files: GitFile[]; upstream: GitUpstream }> {
    // -z would be safer for paths with spaces, but parsing is then more involved;
    // for our flat docs vault the simple line-based form is fine.
    const out = await runGitOk(cwd, ['status', '--porcelain=v1', '-b', '-uall']);
    const lines = out.split('\n');
    const files: GitFile[] = [];
    let upstream: GitUpstream = { branch: '?', upstream: null, ahead: 0, behind: 0 };

    for (const line of lines) {
        if (!line) continue;
        if (line.startsWith('## ')) {
            upstream = parseHeaderLine(line);
            continue;
        }
        const indexStatus = line[0];
        const workingStatus = line[1];
        let path = line.slice(3);
        // Renamed:  "R  old -> new"
        if (path.includes(' -> ')) {
            path = path.split(' -> ').pop() as string;
        }
        files.push({
            path,
            indexStatus,
            workingStatus,
            kind: classify(indexStatus, workingStatus),
        });
    }

    return { files, upstream };
}

function parseHeaderLine(line: string): GitUpstream {
    // Examples:
    //   "## main...origin/main"
    //   "## main...origin/main [ahead 3]"
    //   "## main...origin/main [ahead 3, behind 1]"
    //   "## main...origin/main [behind 2]"
    //   "## main"                                 (no upstream)
    //   "## HEAD (no branch)"                     (detached)
    const body = line.slice(3);
    const m = /^([^.\s]+)(?:\.\.\.([^\s]+))?(?:\s+\[(.+?)\])?\s*$/.exec(body);
    if (!m) {
        return { branch: body || '?', upstream: null, ahead: 0, behind: 0 };
    }
    const branch = m[1];
    const upstream = m[2] ?? null;
    let ahead = 0;
    let behind = 0;
    if (m[3]) {
        const parts = m[3].split(',').map((s) => s.trim());
        for (const part of parts) {
            const am = /^ahead (\d+)$/.exec(part);
            if (am) ahead = parseInt(am[1], 10);
            const bm = /^behind (\d+)$/.exec(part);
            if (bm) behind = parseInt(bm[1], 10);
        }
    }
    return { branch, upstream, ahead, behind };
}

function classify(idx: string, work: string): GitFile['kind'] {
    if (idx === '?' && work === '?') return 'untracked';
    if (idx === 'A' || work === 'A') return 'added';
    if (idx === 'D' || work === 'D') return 'deleted';
    if (idx === 'R' || work === 'R') return 'renamed';
    if (idx === 'M' || work === 'M') return 'modified';
    return 'other';
}

/**
 * Stage all listed files (handles deletes via `git add -A`-style flag).
 *
 * Falls back to `git rm --cached` if `git add` complains about a path being
 * "beyond a symbolic link" — which happens when a tracked directory has been
 * replaced with a symlink to an unrelated git repo (a real situation when
 * extracting a plugin from one vault into its own repo). For deletions, the
 * fallback fully resolves the user's intent; for additions through a symlink,
 * git would never report them as changes anyway.
 */
export async function stagePaths(cwd: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const r = await runGit(cwd, ['add', '-A', '--', ...paths]);
    if (r.exitCode === 0) return;

    const combined = (r.stderr + r.stdout).toLowerCase();
    if (combined.includes('beyond a symbolic link')) {
        const lsFiles = await runGit(cwd, ['ls-files', '--', ...paths], 5_000);
        const indexed = lsFiles.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
        if (indexed.length > 0) {
            await runGitOk(cwd, ['rm', '--cached', '--quiet', '--', ...indexed]);
        }
        return;
    }
    throw new Error(`git add failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim()}`);
}

/**
 * Move files out of the staging area, back into the working tree (unstage).
 * Equivalent to VS Code's `Unstage Changes`.
 *
 * Two backends depending on whether the repo has any commits yet:
 *  - HEAD exists  → `git reset HEAD -- <paths>` (preserves working-tree contents).
 *  - No HEAD yet (fresh repo before initial commit)
 *                 → `git rm --cached -- <paths>` (removes from index without
 *                    deleting the working-tree file).
 */
export async function unstagePaths(cwd: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const head = await runGit(cwd, ['rev-parse', '--verify', 'HEAD'], 5_000);
    if (head.exitCode === 0) {
        await runGitOk(cwd, ['reset', 'HEAD', '--', ...paths]);
    } else {
        // Empty repo — `git reset HEAD` would fail. Use `rm --cached` instead.
        // Filter to paths actually tracked in the index, otherwise `rm --cached`
        // errors out for paths it doesn't know about.
        const lsFiles = await runGit(cwd, ['ls-files', '--cached', '--', ...paths], 5_000);
        const indexed = lsFiles.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
        if (indexed.length > 0) {
            await runGitOk(cwd, ['rm', '--cached', '--', ...indexed]);
        }
    }
}

/**
 * Commit whatever is currently in the index.
 * Caller is expected to stage files explicitly via `stagePaths()` first —
 * this matches VS Code's source-control workflow.
 */
export async function commit(cwd: string, message: string): Promise<void> {
    if (!message.trim()) throw new Error('commit message is empty');
    await runGitOk(cwd, ['commit', '-m', message]);
}

/**
 * Push the current branch. If no upstream is configured, sets it on the default remote.
 * Returns the combined output for surfacing in a toast.
 */
export async function push(cwd: string): Promise<string> {
    // Try plain push first
    const r = await runGit(cwd, ['push'], 60_000);
    if (r.exitCode === 0) return (r.stdout + r.stderr).trim();

    const combined = (r.stdout + r.stderr).toLowerCase();
    if (combined.includes('no upstream') || combined.includes('has no upstream branch')) {
        // Set upstream on origin and retry
        const branchOut = await runGitOk(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const branch = branchOut.trim();
        const r2 = await runGit(cwd, ['push', '--set-upstream', 'origin', branch], 60_000);
        if (r2.exitCode === 0) return (r2.stdout + r2.stderr).trim();
        throw new Error(`push failed: ${(r2.stderr || r2.stdout).trim()}`);
    }
    throw new Error(`push failed: ${(r.stderr || r.stdout).trim()}`);
}

export async function fetch(cwd: string): Promise<string> {
    const r = await runGit(cwd, ['fetch', '--prune'], 60_000);
    if (r.exitCode !== 0) throw new Error(`fetch failed: ${(r.stderr || r.stdout).trim()}`);
    return (r.stdout + r.stderr).trim();
}

export async function pull(cwd: string): Promise<string> {
    const r = await runGit(cwd, ['pull', '--rebase'], 120_000);
    if (r.exitCode !== 0) throw new Error(`pull failed: ${(r.stderr || r.stdout).trim()}`);
    return (r.stdout + r.stderr).trim();
}
