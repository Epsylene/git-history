const vscode = require('vscode');
const path = require('path');
const git = require('./git');
const { short, ago, debounce, ChangedFileItem, openMultiDiff } = require('./common');

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 'es'}`;

class RepoItem extends vscode.TreeItem {
  constructor(root, stashes) {
    super(path.basename(root), stashes.length
      ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.root = root;
    this.stashes = stashes;
    this.id = `repo:${root}`;
    this.description = stashes.length ? plural(stashes.length, 'stash') : 'no stashes';
    this.tooltip = root;
    this.iconPath = new vscode.ThemeIcon('repo');
    this.contextValue = 'repository';
  }
}

function stashTooltip(stash) {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${stash.ref}**`);
  if (stash.branch) {
    md.appendMarkdown(' on ');
    md.appendText(stash.branch);
  }
  md.appendMarkdown(`, ${ago(stash.date)} (${stash.date.toLocaleString()})\n\n`);
  md.appendText(stash.message ?? stash.subject);
  md.appendMarkdown(`\n\n\`${stash.hash}\``);
  return md;
}

class StashItem extends vscode.TreeItem {
  constructor(root, stash) {
    super(stash.message || `WIP on ${stash.branch ?? 'detached HEAD'}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.root = root;
    this.stash = stash;
    this.id = `stash:${stash.hash}`;
    this.description = stash.message && stash.branch ? `${stash.branch}, ${ago(stash.date)}` : ago(stash.date);
    this.tooltip = stashTooltip(stash);
    this.iconPath = new vscode.ThemeIcon('archive');
    this.contextValue = 'stash';
  }
}

// Stashes of every open repository (directly at the top level when there's one).
class StashView {
  constructor(id, api) {
    this.api = api;
    this.signatures = new Map();
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.tree = vscode.window.createTreeView(id, { treeDataProvider: this });
    this.stale = false;
    this.tree.onDidChangeVisibility(() => { if (this.tree.visible && this.stale) this.refresh(); });
  }

  roots() {
    return (this.api?.repositories ?? []).map(repo => repo.rootUri.fsPath).sort();
  }

  refresh() {
    if (!this.tree.visible) { this.stale = true; return; }
    this.stale = false;
    this.emitter.fire();
  }

  // Repository state changes on every status update: only refresh if the stash list changed.
  async checkForChanges() {
    if (!this.tree.visible) { this.stale = true; return; }
    const lists = await Promise.all(this.roots().map(root => git.stashes(root).catch(() => [])));
    const signature = lists.map(list => list.map(stash => stash.hash).join()).join(';');
    if (signature !== this.signature) this.refresh();
  }

  getTreeItem(item) { return item; }

  async getChildren(item) {
    try {
      if (item instanceof StashItem) {
        const files = await git.stashFiles(item.root, item.stash);
        return files.map(file => new ChangedFileItem(item.root, file, item.stash.ref, `stash:${item.stash.hash}`));
      }
      if (item instanceof RepoItem) return item.stashes.map(stash => new StashItem(item.root, stash));
      const roots = this.roots();
      const lists = await Promise.all(roots.map(root => git.stashes(root)));
      this.signature = lists.map(list => list.map(stash => stash.hash).join()).join(';');
      this.tree.message = !roots.length ? 'No Git repository open.'
        : roots.length === 1 && !lists[0].length ? 'No stashes.' : undefined;
      if (roots.length === 1) return lists[0].map(stash => new StashItem(roots[0], stash));
      return roots.map((root, i) => new RepoItem(root, lists[i]));
    } catch (err) {
      this.tree.message = `Git failed: ${err.message}`;
      return [];
    }
  }

  dispose() {
    this.tree.dispose();
    this.emitter.dispose();
  }
}

async function pickRoot(view, item) {
  if (item instanceof RepoItem) return item.root;
  const roots = view.roots();
  if (roots.length <= 1) return roots[0];
  const picked = await vscode.window.showQuickPick(
    roots.map(root => ({ label: path.basename(root), description: root, root })),
    { placeHolder: 'Repository to stash' });
  return picked?.root;
}

function registerStashCommands(context, view) {
  const run = fn => async item => {
    try {
      await fn(item);
    } catch (err) {
      vscode.window.showErrorMessage(err.message);
    }
    view.refresh();
  };

  const stashChanges = untracked => run(async item => {
    const root = await pickRoot(view, item);
    if (!root) return;
    const message = await vscode.window.showInputBox({
      prompt: untracked ? 'Stash changes, including untracked files' : 'Stash changes',
      placeHolder: 'Stash message (optional)',
    });
    if (message === undefined) return;
    const out = await git.stashPush(root, message.trim(), untracked);
    if (/no local changes/i.test(out)) vscode.window.showInformationMessage('There are no local changes to stash.');
  });

  const label = item => `${item.stash.ref}: ${item.label}`;

  context.subscriptions.push(
    vscode.commands.registerCommand('gitHistory.stashChanges', stashChanges(false)),
    vscode.commands.registerCommand('gitHistory.stashChangesUntracked', stashChanges(true)),
    vscode.commands.registerCommand('gitHistory.refreshStashes', () => view.refresh()),
    vscode.commands.registerCommand('gitHistory.applyStash', run(item =>
      git.stashAction(item.root, item.stash.hash, 'apply'))),
    vscode.commands.registerCommand('gitHistory.popStash', run(item =>
      git.stashAction(item.root, item.stash.hash, 'pop'))),
    vscode.commands.registerCommand('gitHistory.dropStash', run(async item => {
      const choice = await vscode.window.showWarningMessage(`Drop ${label(item)}?`,
        { modal: true, detail: 'The stash will be deleted.' }, 'Drop');
      if (choice === 'Drop') await git.stashAction(item.root, item.stash.hash, 'drop');
    })),
    vscode.commands.registerCommand('gitHistory.openStashChanges', run(async item => {
      const files = await git.stashFiles(item.root, item.stash);
      await openMultiDiff(`${label(item)} (${short(item.stash.hash)})`, item.root, files);
    })),
  );
}

// Watches open repositories so the view follows stashes made elsewhere (terminal, SCM menu…).
function watchStashes(context, view, api) {
  const check = debounce(() => view.checkForChanges(), 500);
  const watch = repo => context.subscriptions.push(repo.state.onDidChange(check));
  api.repositories.forEach(watch);
  context.subscriptions.push(
    api.onDidOpenRepository(repo => { watch(repo); view.refresh(); }),
    api.onDidCloseRepository(() => view.refresh()),
  );
}

module.exports = { StashView, registerStashCommands, watchStashes };
