const vscode = require('vscode');
const path = require('path');
const git = require('./git');

const { SCHEME, revisionUri, contentProvider, short, ago, debounce } = require('./common');
const { StashView, registerStashCommands, watchStashes } = require('./stashes');

function tooltip(commit) {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**`);
  md.appendText(commit.author);
  md.appendMarkdown(`**, ${ago(commit.date)} (${commit.date.toLocaleString()})\n\n`);
  for (const line of commit.message.split('\n')) {
    md.appendText(line);
    md.appendMarkdown('  \n');
  }
  md.appendMarkdown(`\n\`${commit.hash}\``);
  return md;
}

class CommitItem extends vscode.TreeItem {
  constructor(target, commit) {
    super(commit.subject || '(no message)');
    this.target = target;
    this.commit = commit;
    this.description = `${commit.author}, ${ago(commit.date)}`;
    this.tooltip = tooltip(commit);
    this.iconPath = new vscode.ThemeIcon('git-commit');
    this.contextValue = 'commit';
    this.command = { command: 'gitHistory.openChanges', title: 'Open Changes', arguments: [this] };
  }
}

class UncommittedItem extends vscode.TreeItem {
  constructor(target) {
    super('Uncommitted changes');
    this.target = target;
    this.iconPath = new vscode.ThemeIcon('edit');
    this.contextValue = 'uncommitted';
    this.command = { command: 'gitHistory.openChanges', title: 'Open Changes', arguments: [this] };
  }
}

class LoadMoreItem extends vscode.TreeItem {
  constructor(view) {
    super('Load more…');
    this.iconPath = new vscode.ThemeIcon('ellipsis');
    this.command = { command: 'gitHistory.loadMore', title: 'Load More', arguments: [view] };
  }
}

const maxCommits = () => vscode.workspace.getConfiguration('gitHistory').get('maxCommits', 100);

// A tree view that follows the active file editor and lists commits for it.
// Subclasses implement compute(editor) → { items, message, description }.
class HistoryView {
  constructor(id) {
    this.id = id;
    this.items = [];
    this.generation = 0;
    this.stale = true;
    this.limit = maxCommits();
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.tree = vscode.window.createTreeView(id, { treeDataProvider: this });
    this.tree.onDidChangeVisibility(() => { if (this.tree.visible && this.stale) this.refresh(); });
    this.follow(vscode.window.activeTextEditor);
  }

  getTreeItem(item) { return item; }
  getChildren(item) { return item ? [] : this.items; }

  // Editors that aren't files on disk (output, our own revisions…) keep the last target.
  follow(editor) {
    if (!editor || editor.document.uri.scheme !== 'file') return false;
    if (this.editor?.document !== editor.document) this.limit = maxCommits();
    this.editor = editor;
    return true;
  }

  async refresh() {
    if (!this.tree.visible) { this.stale = true; return; }
    this.stale = false;
    const generation = ++this.generation;
    if (!this.editor) return this.show({ message: 'Open a file to see its history.' });
    const editor = this.editor;
    let result;
    try {
      result = await vscode.window.withProgress({ location: { viewId: this.id } }, () => this.compute(editor));
    } catch (err) {
      result = { message: `Git failed: ${err.message}` };
    }
    if (generation === this.generation) this.show(result);
  }

  show({ items = [], message, description }) {
    this.items = items;
    this.tree.message = message;
    this.tree.description = description;
    this.emitter.fire();
  }

  dispose() {
    this.tree.dispose();
    this.emitter.dispose();
  }
}

class FileHistoryView extends HistoryView {
  async compute(editor) {
    const doc = editor.document;
    const description = path.basename(doc.uri.fsPath);
    const repo = await git.resolve(doc.uri.fsPath);
    if (!repo) return { message: 'This file isn\'t in a Git repository.', description };
    if (!await git.isTracked(repo.root, repo.rel)) return { message: 'This file isn\'t tracked by Git.', description };
    const target = { ...repo, uri: doc.uri };
    const [{ commits, more }, dirty] = await Promise.all([
      git.fileHistory(repo.root, repo.rel, this.limit),
      doc.isDirty || git.hasChanges(repo.root, repo.rel),
    ]);
    const items = commits.map(commit => new CommitItem(target, commit));
    if (dirty) items.unshift(new UncommittedItem(target));
    if (more) items.push(new LoadMoreItem(this));
    return { items, description, message: items.length ? undefined : 'No commits yet.' };
  }
}

class LineHistoryView extends HistoryView {
  constructor(id) {
    super(id);
    this.cache = new Map();
  }

  // `git log -L` can be slow on long histories: remember recent answers.
  async lineHistory(root, head, rel, range) {
    const key = [root, head, rel, range.start, range.end, this.limit].join('\0');
    if (!this.cache.has(key)) {
      if (this.cache.size >= 50) this.cache.delete(this.cache.keys().next().value);
      const promise = git.lineHistory(root, head, rel, range.start, range.end, this.limit);
      promise.catch(() => this.cache.delete(key));
      this.cache.set(key, promise);
    }
    return this.cache.get(key);
  }

  async compute(editor) {
    const doc = editor.document;
    const { start: from, end: to } = editor.selection;
    const start = from.line + 1;
    // A selection ending at the start of a line doesn't include that line.
    const end = to.line + 1 - (to.line > from.line && to.character === 0 ? 1 : 0);
    const name = path.basename(doc.uri.fsPath);
    const description = start === end ? `${name}:${start}` : `${name}:${start}–${end}`;
    const repo = await git.resolve(doc.uri.fsPath);
    if (!repo) return { message: 'This file isn\'t in a Git repository.', description };
    const head = await git.headSha(repo.root);
    const base = head && await git.show(repo.root, head, repo.rel);
    if (base === null || !head) return { message: 'This file isn\'t committed yet.', description };

    // Line numbers in the editor include uncommitted edits: map them back to HEAD.
    const hunks = await git.diffHunks(base, doc.getText());
    const { range, dirty } = git.mapRange(hunks, start, end);
    const target = { ...repo, uri: doc.uri, line: start };
    const items = [];
    if (dirty) items.push(new UncommittedItem(target));
    if (range) {
      const { commits, more } = await this.lineHistory(repo.root, head, repo.rel, range);
      items.push(...commits.map(commit => new CommitItem(target, commit)));
      if (more) items.push(new LoadMoreItem(this));
    }
    return { items, description, message: items.length ? undefined : 'No commits touch these lines.' };
  }
}

function openChanges(item) {
  const { root, rel, uri, line } = item.target;
  const name = path.basename(uri.fsPath);
  const options = { preview: true };
  if (item instanceof UncommittedItem) {
    if (line) options.selection = new vscode.Range(line - 1, 0, line - 1, 0);
    return vscode.commands.executeCommand('vscode.diff',
      revisionUri(root, rel, 'HEAD'), uri, `${name} (HEAD ↔ Working Tree)`, options);
  }
  const { commit } = item;
  const parent = commit.parents[0] ?? '';
  if (commit.range) options.selection = new vscode.Range(commit.range.start - 1, 0, commit.range.start - 1, 0);
  return vscode.commands.executeCommand('vscode.diff',
    revisionUri(root, commit.oldRel, parent), revisionUri(root, commit.rel, commit.hash),
    `${path.basename(commit.rel)} (${parent ? short(parent) : 'new'} ↔ ${short(commit.hash)})`, options);
}

function openRevision(item) {
  const { commit, target } = item;
  const options = {};
  if (commit.range) options.selection = new vscode.Range(commit.range.start - 1, 0, commit.range.start - 1, 0);
  return vscode.window.showTextDocument(revisionUri(target.root, commit.rel, commit.hash), options);
}

function compareWithWorking(item) {
  const { commit, target } = item;
  return vscode.commands.executeCommand('vscode.diff',
    revisionUri(target.root, commit.rel, commit.hash), target.uri,
    `${path.basename(commit.rel)} (${short(commit.hash)} ↔ Working Tree)`);
}

// The built-in Git extension's API, or null if Git is disabled.
async function gitApi() {
  try {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) return null;
    return (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
  } catch {
    return null;
  }
}

// Refresh when a repository's HEAD moves (commit, checkout, pull…).
function watchHeads(context, api, onChange) {
  const watch = repo => {
    let head = repo.state.HEAD?.commit;
    context.subscriptions.push(repo.state.onDidChange(() => {
      if (repo.state.HEAD?.commit === head) return;
      head = repo.state.HEAD?.commit;
      onChange();
    }));
  };
  api.repositories.forEach(watch);
  context.subscriptions.push(api.onDidOpenRepository(watch));
}

async function activate(context) {
  const api = await gitApi();
  const fileView = new FileHistoryView('gitHistory.fileHistory');
  const lineView = new LineHistoryView('gitHistory.lineHistory');
  const stashView = new StashView('gitHistory.stashes', api);
  const views = [fileView, lineView];
  const refreshAll = () => views.forEach(view => view.refresh());
  const refreshLines = debounce(() => lineView.refresh(), 250);

  context.subscriptions.push(
    ...views,
    stashView,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (fileView.follow(editor)) fileView.refresh();
      if (lineView.follow(editor)) refreshLines();
    }),
    vscode.window.onDidChangeTextEditorSelection(({ textEditor }) => {
      if (lineView.follow(textEditor)) refreshLines();
    }),
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      if (document === lineView.editor?.document) refreshLines();
    }),
    vscode.workspace.onDidSaveTextDocument(debounce(refreshAll, 250)),
    vscode.commands.registerCommand('gitHistory.refresh', refreshAll),
    vscode.commands.registerCommand('gitHistory.loadMore', view => {
      view.limit += maxCommits();
      view.refresh();
    }),
    vscode.commands.registerCommand('gitHistory.openChanges', openChanges),
    vscode.commands.registerCommand('gitHistory.openRevision', openRevision),
    vscode.commands.registerCommand('gitHistory.compareWithWorking', compareWithWorking),
    vscode.commands.registerCommand('gitHistory.copyHash', item => vscode.env.clipboard.writeText(item.commit.hash)),
    vscode.commands.registerCommand('gitHistory.copyMessage', item => vscode.env.clipboard.writeText(item.commit.message)),
  );
  registerStashCommands(context, stashView);
  if (api) {
    watchHeads(context, api, debounce(refreshAll, 250));
    watchStashes(context, stashView, api);
  }
  refreshAll();
}

function deactivate() {
  return git.cleanup();
}

module.exports = { activate, deactivate };
