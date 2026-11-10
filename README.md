# PR Status Tracker

Local dashboard + macOS pop-ups when a PR changes status. Polls GitHub every 5 min through `gh` (uses your existing `gh auth`).

- Run once: `node server.mjs` → http://localhost:4777
- Run always (background, starts at login): `./install.sh` · remove with `./uninstall.sh`

Tracks every open PR you authored, plus any PR you add on the dashboard.

## Statuses
| Status | Rule |
|---|---|
| Draft — no adversarial review | Draft, no review with the "Automated adversarial review" footer |
| Draft — adversarial review comments | Draft, has unresolved `Adversarial Review: High/Medium/Low` finding threads |
| Draft — ready for review | Draft, adversarial review posted, every finding thread resolved |
| Ready for review — with comments | Not draft, has unresolved review threads or changes requested |
| Ready for review — awaiting review | Not draft, no open threads, not yet mergeable (needs approval, checks, etc.) |
| Able to merge | GitHub says mergeable and merge state is CLEAN |
| Merged / Closed | Notified once; auto-tracked PRs then drop off |

High-risk highlights are left out of the counts because nobody ever resolves them.

## Options (env vars)
`NOTIFY=banner` uses a Notification Center banner instead of the default dialog · `POLL_MINUTES=5` · `PORT=4777` · `TRACK_MINE=0` tracks only PRs you add.
