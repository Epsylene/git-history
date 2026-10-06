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

module.exports = { SCHEME, revisionUri, contentProvider, short, ago, debounce };
