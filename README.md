# Git History

Two views in the Source Control sidebar that follow the active editor:

- **File History**: commits that touched the current file, following renames.
- **Line History**: commits that touched the selected lines (or the cursor's line), using `git log -L`. Uncommitted edits are taken into account: line numbers are mapped back to `HEAD`, and an "Uncommitted changes" entry shows up when the selection has local edits.

Click a commit to open its diff for the file. Right-click for: open the file at that revision, compare it with the working file, copy the hash or message.

`gitHistory.maxCommits` (default 100) sets how many commits load at once; "Load more…" fetches the next batch.

The views can be dragged elsewhere (Explorer, panel…) or hidden from the Source Control `…` menu.
