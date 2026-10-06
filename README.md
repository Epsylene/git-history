# Git History

Three views in the Source Control sidebar.

Following the active editor:

- **File History**: commits that touched the current file, following renames.
- **Line History**: commits that touched the selected lines (or the cursor's line), using `git log -L`. Uncommitted edits are taken into account: line numbers are mapped back to `HEAD`, and an "Uncommitted changes" entry shows up when the selection has local edits.

And for the open repositories:

- **Stashes**: stashes of each repository (directly at the top when there's only one). Expand one to see its files, untracked ones included, and click a file for its diff. Inline buttons open all its changes in one diff tab, apply, pop or drop it (dropping asks first). The `+` in the title stashes the current changes with an optional message; its `…` menu has the variant that includes untracked files.

In the history views, click a commit to open its diff for the file. Right-click for: open the file at that revision, compare it with the working file, copy the hash or message.

`gitHistory.maxCommits` (default 100) sets how many commits load at once; "Load more…" fetches the next batch.

The views can be dragged elsewhere (Explorer, panel…) or hidden from the Source Control `…` menu.
