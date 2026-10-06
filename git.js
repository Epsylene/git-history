const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

// Keep the output parseable whatever the user's git config says.
const BASE_ARGS = ['-c', 'core.quotepath=off', '-c', 'color.ui=never'];
const LOG_ARGS = ['--no-show-signature', '--no-color', '--no-ext-diff', '--no-textconv'];
// Record start, fields, then the end of the header (the patch or name-status follows).
const FORMAT = '--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B%x1d';

function git(cwd, args, okCodes = [0]) {
  return new Promise((resolve, reject) => {
    execFile('git', [...BASE_ARGS, ...args], { cwd, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? err.code : 0;
      if (okCodes.includes(code)) resolve(stdout);
      else reject(new Error((stderr || '').trim() || (stdout || '').trim() || err.message));
    });
  });
}

const roots = new Map();

function repoRoot(dir) {
  if (!roots.has(dir)) {
    roots.set(dir, git(dir, ['rev-parse', '--show-toplevel']).then(out => out.trim(), () => {
      roots.delete(dir); // the folder may become a repository later
      return null;
    }));
  }
  return roots.get(dir);
}

// Returns { root, rel } for a file on disk, or null outside a repository.
async function resolve(fsPath) {
  const real = await fs.realpath(fsPath).catch(() => fsPath);
  const root = await repoRoot(path.dirname(real));
  if (!root) return null;
  return { root, rel: path.relative(root, real).split(path.sep).join('/') };
}

function headSha(root) {
  return git(root, ['rev-parse', '--verify', '-q', 'HEAD']).then(out => out.trim(), () => null);
}

async function isTracked(root, rel) {
  return (await git(root, ['ls-files', '--', rel])).trim() !== '';
}

async function hasChanges(root, rel) {
  return (await git(root, ['status', '--porcelain', '--', rel]).catch(() => '')).trim() !== '';
}

// File content at a revision, or null if it doesn't exist there.
function show(root, ref, rel) {
  return git(root, ['show', `${ref}:${rel}`]).catch(() => null);
}

function parseHeader(header) {
  const [hash, parents, author, email, time, body] = header.split('\x1f');
  const message = body.trim();
  return {
    hash,
    parents: parents.split(' ').filter(Boolean),
    author,
    email,
    date: new Date(Number(time) * 1000),
    message,
    subject: message.split('\n')[0],
  };
}

function records(out) {
  return out.split('\x1e').slice(1).map(record => {
    const end = record.indexOf('\x1d');
    return { commit: parseHeader(record.slice(0, end)), rest: record.slice(end + 1) };
  });
}

// Commits touching a file, newest first, following renames. Each commit gets
// the file's path in that commit (`rel`) and in its parent (`oldRel`).
async function fileHistory(root, rel, limit) {
  const out = await git(root, ['log', ...LOG_ARGS, '--follow', '--name-status', FORMAT, `-n${limit + 1}`, '--', rel]);
  let current = rel;
  const commits = records(out).map(({ commit, rest }) => {
    const line = rest.split('\n').find(l => l.includes('\t'));
    if (line) {
      const parts = line.split('\t');
      const renamed = /^[RC]/.test(parts[0]);
      commit.status = parts[0][0];
      commit.oldRel = parts[1];
      commit.rel = renamed ? parts[2] : parts[1];
    } else {
      commit.rel = commit.oldRel = current;
    }
    current = commit.oldRel;
    return commit;
  });
  return { commits: commits.slice(0, limit), more: commits.length > limit };
}

const stripTab = s => s.replace(/\t$/, '');

// Commits touching lines start..end (1-based, as of `rev`), newest first.
// Each commit gets the file's paths and the lines' range after the commit.
async function lineHistory(root, rev, rel, start, end, limit) {
  const out = await git(root, ['log', ...LOG_ARGS, '--src-prefix=a/', '--dst-prefix=b/', FORMAT,
    `-n${limit + 1}`, `-L${start},${end}:${rel}`, rev]);
  const commits = records(out).map(({ commit, rest }) => {
    const newPath = rest.match(/^\+\+\+ b\/(.*)$/m);
    const oldPath = rest.match(/^--- (?:a\/(.*)|\/dev\/null)$/m);
    commit.rel = newPath ? stripTab(newPath[1]) : rel;
    commit.oldRel = oldPath && oldPath[1] ? stripTab(oldPath[1]) : commit.rel;
    const hunks = [...rest.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)]
      .map(m => ({ start: Number(m[1]), count: m[2] === undefined ? 1 : Number(m[2]) }));
    if (hunks.length) {
      const last = hunks[hunks.length - 1];
      commit.range = { start: Math.max(1, hunks[0].start), end: last.start + Math.max(last.count, 1) - 1 };
    }
    return commit;
  });
  return { commits: commits.slice(0, limit), more: commits.length > limit };
}

let tmpDir;
let tmpCount = 0;

// Line hunks between two texts, as { oldStart, oldCount, newStart, newCount }.
async function diffHunks(before, after) {
  if (before === after) return [];
  tmpDir ??= fs.mkdtemp(path.join(os.tmpdir(), 'git-history-'));
  const dir = await tmpDir;
  const id = tmpCount++;
  const a = path.join(dir, `${id}.a`);
  const b = path.join(dir, `${id}.b`);
  try {
    await Promise.all([fs.writeFile(a, before), fs.writeFile(b, after)]);
    const out = await git(dir, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--ignore-cr-at-eol', '-U0', a, b], [0, 1]);
    return [...out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(m => ({
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
    }));
  } finally {
    fs.rm(a, { force: true });
    fs.rm(b, { force: true });
  }
}

// Maps working lines start..end (1-based) to the committed version through
// `hunks`. Returns the committed range (null if every line is new) and
// whether any line in the selection has uncommitted changes.
function mapRange(hunks, start, end) {
  let lo = Infinity;
  let hi = -Infinity;
  let dirty = false;
  const add = (a, b) => { lo = Math.min(lo, a); hi = Math.max(hi, b); };
  for (let line = start; line <= end; line++) {
    let offset = 0;
    let changed = false;
    for (const h of hunks) {
      const first = h.newCount ? h.newStart : h.newStart + 1;
      if (line < first) break;
      if (line < first + h.newCount) { changed = true; break; }
      offset += h.oldCount - h.newCount;
    }
    if (changed) dirty = true;
    else add(line + offset, line + offset);
  }
  // Committed lines replaced or deleted inside the selection still belong to it.
  for (const h of hunks) {
    const inside = h.newCount
      ? h.newStart <= end && h.newStart + h.newCount - 1 >= start
      : start <= h.newStart && h.newStart + 1 <= end;
    if (!inside) continue;
    dirty = true;
    if (h.oldCount) add(h.oldStart, h.oldStart + h.oldCount - 1);
  }
  return { range: lo === Infinity ? null : { start: lo, end: hi }, dirty };
}

// Stashes, newest first. `ref` (stash@{n}) shifts as stashes come and go: act on `hash`.
async function stashes(root) {
  const out = await git(root, ['stash', 'list', '--format=%H%x1f%P%x1f%gd%x1f%ct%x1f%gs']);
  return out.split('\n').filter(Boolean).map(line => {
    const [hash, parents, ref, time, subject] = line.split('\x1f');
    const m = subject.match(/^(WIP on|On) ([^:]*): (.*)$/s);
    return {
      hash,
      parents: parents.split(' ').filter(Boolean),
      ref,
      date: new Date(Number(time) * 1000),
      branch: m ? m[2] : undefined,
      // `git stash` without a message records "WIP on <branch>: <HEAD's subject>".
      message: m && m[1] === 'On' ? m[3] : undefined,
      subject,
    };
  });
}

// Files in a stash as { status, rel, oldRel, ref, oldRef }: the content stashed
// is `ref:rel`, the content it was based on is `oldRef:oldRel` (empty ref: none).
async function stashFiles(root, stash) {
  const [base, , untracked] = stash.parents;
  const out = await git(root, ['diff-tree', '-r', '-M', '--name-status', '-z', '--no-ext-diff', base, stash.hash]);
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i + 1 < parts.length;) {
    const status = parts[i++];
    const oldRel = parts[i++];
    const rel = /^[RC]/.test(status) ? parts[i++] : oldRel;
    files.push({ status: status[0], rel, oldRel, ref: stash.hash, oldRef: status[0] === 'A' ? '' : base });
  }
  if (untracked) {
    const names = await git(root, ['ls-tree', '-r', '-z', '--name-only', untracked]);
    for (const rel of names.split('\0').filter(Boolean)) {
      files.push({ status: 'U', rel, oldRel: rel, ref: untracked, oldRef: '' });
    }
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

// Runs `git stash <action>` (apply, pop, drop) on the stash with this hash.
async function stashAction(root, hash, action) {
  const stash = (await stashes(root)).find(s => s.hash === hash);
  if (!stash) throw new Error('This stash no longer exists.');
  return git(root, ['stash', action, stash.ref]);
}

function stashPush(root, message, untracked) {
  const args = ['stash', 'push'];
  if (untracked) args.push('--include-untracked');
  if (message) args.push('-m', message);
  return git(root, args);
}

async function cleanup() {
  if (tmpDir) await fs.rm(await tmpDir, { recursive: true, force: true });
}

module.exports = {
  resolve, headSha, isTracked, hasChanges, show, fileHistory, lineHistory, diffHunks, mapRange,
  stashes, stashFiles, stashAction, stashPush, cleanup,
};
