const vscode = require('vscode');
const path = require('path');
const git = require('./git');

const SCHEME = 'git-history';

// Read-only documents holding a file's content at a revision.
// An empty ref (no parent) or a missing file gives an empty document.
function revisionUri(root, rel, ref) {
  return vscode.Uri.from({
    scheme: SCHEME,
    path: vscode.Uri.file(path.join(root, rel)).path,
    query: new URLSearchParams({ root, rel, ref }).toString(),
  });
}

const contentProvider = {
  async provideTextDocumentContent(uri) {
    const params = new URLSearchParams(uri.query);
    const ref = params.get('ref');
    if (!ref) return '';
    return (await git.show(params.get('root'), ref, params.get('rel'))) ?? '';
  },
};

const short = hash => hash.slice(0, 7);

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const UNITS = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];

function ago(date) {
  const seconds = (date.getTime() - Date.now()) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(0, 'minute');
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function commitTooltip(commit) {
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

const STATUS = { A: 'added', D: 'deleted', M: 'modified', R: 'renamed', C: 'copied', T: 'type changed', U: 'untracked' };

// A file from git.diffFiles: click for its diff, titled `${name} (${label})`.
class ChangedFileItem extends vscode.TreeItem {
  constructor(root, file, label, idPrefix) {
    super(path.posix.basename(file.rel));
    this.id = `${idPrefix}:${file.status}:${file.rel}`;
    const dir = path.posix.dirname(file.rel);
    const status = file.status === 'R' ? `renamed from ${file.oldRel}` : file.status === 'M' ? '' : STATUS[file.status];
    this.description = [dir === '.' ? '' : dir, status].filter(Boolean).join(' · ');
    this.tooltip = `${file.rel} (${STATUS[file.status] ?? file.status})`;
    // A file URI would pick up the working tree's SCM decorations: keep the revision's.
    this.resourceUri = revisionUri(root, file.rel, file.ref);
    this.command = {
      command: 'vscode.diff',
      title: 'Open Changes',
      arguments: [revisionUri(root, file.oldRel, file.oldRef), this.resourceUri, `${path.posix.basename(file.rel)} (${label})`],
    };
  }
}

// Opens files from git.diffFiles side by side in one multi-diff editor.
function openMultiDiff(title, root, files) {
  return vscode.commands.executeCommand('vscode.changes', title, files.map(file => [
    vscode.Uri.file(path.join(root, file.rel)),
    revisionUri(root, file.oldRel, file.oldRef),
    revisionUri(root, file.rel, file.ref),
  ]));
}

const REF_ICONS = { branch: 'git-branch', remote: 'cloud', tag: 'tag' };

// Quick-pick of branches and tags, most recent first, after the `extra` items.
// Typing anything else (a commit hash, HEAD~3…) offers it as is.
// Resolves to the picked item ({ ref } for a revision), or undefined.
async function pickRef(root, { placeHolder, current, currentLabel, extra = [] }) {
  const refs = await git.refs(root);
  const items = [...extra, ...refs.map(ref => ({
    label: `$(${REF_ICONS[ref.kind]}) ${ref.name}`,
    description: [ref.name === current ? currentLabel : '', ago(ref.date)].filter(Boolean).join(' · '),
    ref: ref.name,
  }))];
  const pick = vscode.window.createQuickPick();
  pick.placeholder = placeHolder;
  pick.matchOnDescription = true;
  pick.items = items;
  return new Promise(resolve => {
    pick.onDidChangeValue(value => {
      const typed = value.trim();
      pick.items = typed && !refs.some(ref => ref.name === typed)
        ? [{ label: `$(git-commit) ${typed}`, description: 'commit or revision', ref: typed, alwaysShow: true }, ...items]
        : items;
    });
    pick.onDidAccept(() => {
      resolve(pick.selectedItems[0]);
      pick.hide();
    });
    pick.onDidHide(() => {
      resolve(undefined);
      pick.dispose();
    });
    pick.show();
  });
}

module.exports = {
  pickRef,
  SCHEME, revisionUri, contentProvider, short, ago, debounce, commitTooltip, ChangedFileItem, openMultiDiff,
};
