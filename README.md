# Git History

Four views in the Source Control sidebar.

Following the active editor:

- **File History**: commits that touched the current file, following renames.
- **Line History**: commits that touched the selected lines (or the cursor's line), using `git log -L`. Uncommitted edits are taken into account: line numbers are mapped back to `HEAD`, and an "Uncommitted changes" entry shows up when the selection has local edits.

And for the open repositories:

- **Stashes**: stashes of each repository (directly at the top when there's only one). Expand one to see its files, untracked ones included, and click a file for its diff. Inline buttons open all its changes in one diff tab, apply, pop or drop it (dropping asks first). The `+` in the title stashes the current changes with an optional message; its `…` menu has the variant that includes untracked files.
- **Branch Changes**: what the current branch has on top of a base branch, like a pull request: its **Commits** (expand one for its files) and the **Files Changed** since the merge base. The base defaults to the remote's default branch (`origin/HEAD`), else `main` or `master`; the title bar's compare button picks another branch or tag, per repository and workspace. The multi-diff button opens every changed file in one diff tab.

In the history views, click a commit to open its diff for the file. Right-click for: open the file at that revision, compare it with the working file, copy the hash or message.

The File History title bar's compare button (also **Git History: Compare File with Branch or Tag…** in the command palette) diffs the current file, unsaved edits included, with its version on a branch, tag, or any revision typed in (a hash, `HEAD~3`…). It follows renames between the two.

`gitHistory.maxCommits` (default 100) sets how many commits load at once; "Load more…" fetches the next batch.

The views can be dragged elsewhere (Explorer, panel…) or hidden from the Source Control `…` menu.
