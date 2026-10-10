# ResearchTube GitHub statistics

This folder stores a permanent daily archive at [history.json](history.json).
Collection runs daily at **02:35 UTC**, or on demand from **GitHub → Actions →
Collect ResearchTube statistics → Run workflow**.

## What is collected?

- Release downloads: cumulative `download_count` for each GitHub Release asset.
- Repository stars, forks, and watchers.
- When configured: daily repository views, unique visitors, clones, and unique
  cloners. The GitHub API supplies only the last 14 days, which the collector
  continuously backfills into `traffic_days`.
- When configured: rolling 14-day top referrers and most visited GitHub pages,
  saved with each daily snapshot.

**Downloads are not unique users or installations.** Daily unique visitor
figures cannot be added together to obtain an all-time unique user count.
Referrers and top paths are limited to GitHub's top 10 entries per snapshot.
All data is aggregated; no individual identities are collected.

## One-time setup for the full traffic statistics

GitHub does **not** give its default workflow `GITHUB_TOKEN` enough access
to the Traffic API. An additional read-only secret is necessary:

1. Open https://github.com/settings/personal-access-tokens/new .
2. Create a **fine-grained** personal access token, restricted to the
   `ilinic/ResearchTube` repository only.
3. Set **Repository permissions → Administration: Read-only**. Do not grant
   write or unrelated permissions. Choose an appropriate expiration and renew
   it before it expires.
4. Open the repository's **Settings → Secrets and variables → Actions →
   New repository secret**.
5. Name it `GH_TRAFFIC_STATS_TOKEN`; paste the token value there.
6. Open **Actions → Collect ResearchTube statistics → Run workflow**.
7. After a successful run, check `stats/history.json`. Each snapshot should
   contain `"traffic": {"status": "ok", ...}`.

Never paste this token into an issue, commit, README, or ChatGPT message.
The workflow secret is used for traffic requests only. Git commits use the
built-in, short-lived `GITHUB_TOKEN`, scoped to `contents: write` in the
workflow.

If token access is missing or expired, release and popularity statistics still
update, but `traffic.status` reports `not_configured` or `unavailable`
instead of silently inventing zero visits.

## Troubleshooting

- If the commit step reports 403, check **Settings → Actions → General →
  Workflow permissions** and branch protection. The workflow must be allowed
  to write its `stats/history.json` file to `main`.
- A scheduled GitHub Actions run may be delayed or skipped during service
  load. You can trigger it manually.
- Do not interpret today's still-in-progress traffic totals as final.
- This automated collection commits only to the existing `main` branch;
  it does not create deployment branches or require any hosting.
