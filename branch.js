const vscode = require('vscode');
const path = require('path');
const git = require('./git');
const {
  revisionUri, short, ago, debounce, commitTooltip, CommitItem, STATUS, ChangedFileItem, openMultiDiff, pickRef,
} = require('./common');

const Collapsed = vscode.TreeItemCollapsibleState.Collapsed;
const Expanded = vscode.TreeItemCollapsibleState.Expanded;

const comparison = data => `${data.branch ?? short(data.changes?.head ?? 'HEAD')} vs ${data.base}`;

class RepoItem extends vscode.TreeItem {
  constructor(data) {
    super(path.basename(data.root), data.changes ? Expanded : vscode.TreeItemCollapsibleState.None);
    this.data = data;
    this.id = `branch-repo:${data.root}`;
    this.description = data.error ?? (data.base ? comparison(data) : 'no base branch');
    this.tooltip = data.root;
    this.iconPath = new vscode.ThemeIcon('repo');
    this.contextValue = 'branchRepo';
  }
}

class GroupItem extends vscode.TreeItem {
  constructor(data, kind) {
    const { commits, more, files } = data.changes;
    const commitGroup = kind === 'commits';
    super(commitGroup ? 'Commits' : 'Files Changed', commitGroup ? Expanded : Collapsed);
    this.data = data;
    this.kind = kind;
    this.id = `branch-${kind}:${data.root}`;
    this.description = commitGroup ? `${commits.length}${more ? '+' : ''}` : `${files.length}`;
    this.iconPath = new vscode.ThemeIcon(commitGroup ? 'git-commit' : 'files');
    this.contextValue = commitGroup ? 'branchCommits' : 'branchFiles';
  }
}

class BranchCommitItem extends vscode.TreeItem {
  constructor(root, commit) {
    super(commit.subject || '(no message)', Collapsed);
    this.root = root;
    this.commit = commit;
    this.id = `branch-commit:${root}:${commit.hash}`;
    this.description = `${commit.author}, ${ago(commit.date)}`;
    this.tooltip = commitTooltip(commit);
    this.iconPath = new vscode.ThemeIcon('git-commit');
    this.contextValue = 'branchCommit';
  }
}

// The active file's changes on the branch: from the merge base to the working file.
class FileGroupItem extends vscode.TreeItem {
  constructor(data, file) {
    super(path.basename(file.uri.fsPath), Expanded);
    this.data = data;
    this.id = `branch-file:${data.root}`;
    this.iconPath = vscode.ThemeIcon.File;
    this.contextValue = 'branchFile';
    this.update(file);
  }

  update(file) {
    this.file = file;
    this.label = path.basename(file.uri.fsPath);
    this.resourceUri = file.uri;
    const { commits, more } = file.history;
    const status = file.status === 'R' ? `renamed from ${file.baseRel}` : STATUS[file.status];
    const count = commits.length && `${commits.length}${more ? '+' : ''} commit${commits.length === 1 && !more ? '' : 's'}`;
    const uncommitted = file.dirty && file.status !== 'U' && 'uncommitted changes';
    this.description = [status, count, uncommitted].filter(Boolean).join(' · ') || 'unchanged on this branch';
    this.tooltip = `${file.rel}: changes since ${short(this.data.changes.mergeBase)}, the merge base with ${this.data.base}`;
  }
}

// What the current branch has on top of a base branch, for each open repository.
class BranchView {
  constructor(id, api, state) {
    this.api = api;
    this.state = state;
    this.limit = maxCommits();
    this.data = new Map();
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.tree = vscode.window.createTreeView(id, { treeDataProvider: this });
    this.stale = false;
    this.tree.onDidChangeVisibility(() => { if (this.tree.visible && this.stale) this.refresh(); });
    this.fileGroups = new Map();
    this.fileGeneration = 0;
    this.follow(vscode.window.activeTextEditor);
  }

  // Editors that aren't files on disk (output, our own revisions…) keep the last file.
  follow(editor) {
    if (!editor || editor.document.uri.scheme !== 'file') return;
    if (editor.document.uri.toString() === this.fileUri?.toString()) return;
    this.fileUri = editor.document.uri;
    this.refreshFile();
  }

  // Updates the active file's group in place when it stays in the same repository.
  async refreshFile() {
    if (!this.tree.visible) { this.stale = true; return; }
    const generation = ++this.fileGeneration;
    const repo = this.fileUri && await git.resolve(this.fileUri.fsPath);
    const group = repo && this.fileGroups.get(repo.root);
    if (!group) { this.refresh(); return; }
    try {
      const file = await this.loadFile(group.data);
      if (generation !== this.fileGeneration) return;
      if (!file) { this.refresh(); return; }
      group.update(file);
      this.emitter.fire(group);
    } catch {
      this.refresh();
    }
  }

  roots() {
    return (this.api?.repositories ?? []).map(repo => repo.rootUri.fsPath).sort();
  }

  savedBase(root) { return this.state.get(`gitHistory.base:${root}`); }
  setBase(root, base) { return this.state.update(`gitHistory.base:${root}`, base); }

  async base(root) {
    const saved = this.savedBase(root);
    if (saved && await git.resolveRef(root, saved)) return saved;
    return git.defaultBase(root);
  }

  refresh() {
    if (!this.tree.visible) { this.stale = true; return; }
    this.stale = false;
    this.fileGroups.clear();
    this.emitter.fire();
  }

  // What the view depends on: each repository's HEAD and base commits.
  async signature() {
    const parts = await Promise.all(this.roots().map(async root => {
      const base = await this.base(root);
      return [root, await git.resolveRef(root, 'HEAD'), base, base && await git.resolveRef(root, base)].join();
    }));
    return parts.join(';');
  }

  async checkForChanges() {
    if (!this.tree.visible) { this.stale = true; return; }
    if (await this.signature() !== this.lastSignature) this.refresh();
  }

  async load(root) {
    const data = { root, branch: await git.currentBranch(root), base: await this.base(root) };
    if (data.base) {
      try {
        data.changes = await git.branchChanges(root, data.base, this.limit);
      } catch (err) {
        data.error = err.message;
      }
    }
    return data;
  }

  // The active file's path and commits on the branch, if it's in this repository.
  async loadFile(data) {
    const uri = this.fileUri;
    if (!uri || !data.changes) return null;
    const repo = await git.resolve(uri.fsPath);
    if (!repo || path.resolve(repo.root) !== path.resolve(data.root)) return null;
    const { mergeBase, baseSha, head, files } = data.changes;
    const changed = files.find(file => file.rel === repo.rel);
    const baseRel = changed ? changed.oldRel : repo.rel;
    const [history, atBase, dirty] = await Promise.all([
      git.fileHistory(data.root, repo.rel, this.limit, `${baseSha}..${head}`),
      changed?.status === 'A' ? null : git.show(data.root, mergeBase, baseRel),
      git.hasChanges(data.root, repo.rel),
    ]);
    const status = changed?.status ?? (atBase === null ? 'U' : undefined);
    return { uri, rel: repo.rel, baseRel, baseRef: atBase === null ? '' : mergeBase, status, history, dirty };
  }

  fileChildren(group) {
    const { data, file } = group;
    const name = path.basename(file.uri.fsPath);
    const diff = new vscode.TreeItem('Changes on this branch');
    diff.description = `${short(data.changes.mergeBase)} ↔ working tree`;
    diff.tooltip = `${file.rel} since the merge base with ${data.base}, uncommitted changes included`;
    diff.iconPath = new vscode.ThemeIcon('diff');
    diff.command = {
      command: 'vscode.diff',
      title: 'Open Changes',
      arguments: [revisionUri(data.root, file.baseRel, file.baseRef), file.uri,
        `${name} (${short(data.changes.mergeBase)} ↔ Working Tree)`],
    };
    const target = { root: data.root, rel: file.rel, uri: file.uri };
    const items = [diff, ...file.history.commits.map(commit => new CommitItem(target, commit))];
    if (file.history.more) items.push(this.loadMoreItem());
    return items;
  }

  loadMoreItem() {
    const more = new vscode.TreeItem('Load more…');
    more.iconPath = new vscode.ThemeIcon('ellipsis');
    more.command = { command: 'gitHistory.loadMore', title: 'Load More', arguments: [this] };
    return more;
  }

  getTreeItem(item) { return item; }

  async getChildren(item) {
    try {
      if (item instanceof BranchCommitItem) {
        const files = await git.commitFiles(item.root, item.commit);
        return files.map(file => new ChangedFileItem(item.root, file, short(item.commit.hash), item.id));
      }
      if (item instanceof FileGroupItem) return this.fileChildren(item);
      if (item instanceof GroupItem) {
        const { root, changes } = item.data;
        if (item.kind === 'files') {
          return changes.files.map(file => new ChangedFileItem(root, file, `${short(changes.mergeBase)} ↔ ${short(changes.head)}`, item.id));
        }
        const commits = changes.commits.map(commit => new BranchCommitItem(root, commit));
        if (changes.more) commits.push(this.loadMoreItem());
        return commits;
      }
      if (item instanceof RepoItem) return item.data.changes ? this.groups(item.data) : [];

      this.lastSignature = await this.signature();
      const roots = this.roots();
      const all = await Promise.all(roots.map(root => this.load(root)));
      this.data = new Map(all.map(data => [data.root, data]));
      this.tree.description = undefined;
      this.tree.message = roots.length ? undefined : 'No Git repository open.';
      if (roots.length !== 1) return all.map(data => new RepoItem(data));
      const [data] = all;
      if (!data.base) this.tree.message = 'No main branch found: pick a base branch with the button above.';
      else if (data.error) this.tree.message = data.error;
      else this.tree.description = comparison(data);
      if (data.changes && !data.changes.commits.length && !data.changes.files.length) {
        this.tree.message = `${comparison(data)}: nothing new.`;
      }
      return data.changes ? await this.groups(data) : [];
    } catch (err) {
      this.tree.message = `Git failed: ${err.message}`;
      return [];
    }
  }

  async groups(data) {
    const groups = [];
    const file = await this.loadFile(data).catch(() => null);
    if (file) {
      const group = new FileGroupItem(data, file);
      this.fileGroups.set(data.root, group);
      groups.push(group);
    }
    if (data.changes.commits.length || data.changes.files.length) {
      groups.push(new GroupItem(data, 'commits'), new GroupItem(data, 'files'));
    }
    return groups;
  }

  dispose() {
    this.tree.dispose();
    this.emitter.dispose();
  }
}

const maxCommits = () => vscode.workspace.getConfiguration('gitHistory').get('maxCommits', 100);

async function pickRoot(view, item, placeHolder) {
  if (item?.data?.root) return item.data.root;
  const roots = view.roots();
  if (roots.length <= 1) return roots[0];
  const picked = await vscode.window.showQuickPick(
    roots.map(root => ({ label: path.basename(root), description: root, root })), { placeHolder });
  return picked?.root;
}

async function changeBase(view, item) {
  const root = await pickRoot(view, item, 'Repository to compare');
  if (!root) return;
  const [current, fallback] = await Promise.all([view.base(root), git.defaultBase(root)]);
  const picked = await pickRef(root, {
    placeHolder: `Compare ${path.basename(root)} with…`,
    current,
    currentLabel: 'current base',
    extra: fallback ? [{ label: `$(discard) Default (${fallback})`, reset: true }] : [],
  });
  if (!picked) return;
  if (!picked.reset && !await git.resolveRef(root, picked.ref)) throw new Error(`Unknown revision: ${picked.ref}`);
  await view.setBase(root, picked.reset ? undefined : picked.ref);
  view.refresh();
}

function registerBranchCommands(context, view) {
  const run = fn => async item => {
    try {
      await fn(item);
    } catch (err) {
      vscode.window.showErrorMessage(err.message);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('gitHistory.changeBase', run(item => changeBase(view, item))),
    vscode.commands.registerCommand('gitHistory.refreshBranch', () => view.refresh()),
    vscode.commands.registerCommand('gitHistory.openBranchChanges', run(async item => {
      const root = await pickRoot(view, item, 'Repository to open');
      if (!root) return;
      const data = view.data.get(root) ?? await view.load(root);
      if (!data.changes) throw new Error(data.error ?? 'Pick a base branch first.');
      if (!data.changes.files.length) {
        vscode.window.showInformationMessage(`${comparison(data)}: no files changed.`);
        return;
      }
      await openMultiDiff(comparison(data), root, data.changes.files);
    })),
    vscode.commands.registerCommand('gitHistory.openCommitChanges', run(async item => {
      const files = await git.commitFiles(item.root, item.commit);
      await openMultiDiff(`${short(item.commit.hash)} ${item.commit.subject}`, item.root, files);
    })),
  );
}

// Refresh when a repository's HEAD or the base branch moves (commit, checkout, fetch…).
function watchBranches(context, view, api) {
  const check = debounce(() => view.checkForChanges().catch(() => {}), 500);
  const watch = repo => context.subscriptions.push(repo.state.onDidChange(check));
  api.repositories.forEach(watch);
  context.subscriptions.push(
    api.onDidOpenRepository(repo => { watch(repo); view.refresh(); }),
    api.onDidCloseRepository(() => view.refresh()),
  );
}

module.exports = { BranchView, registerBranchCommands, watchBranches };
