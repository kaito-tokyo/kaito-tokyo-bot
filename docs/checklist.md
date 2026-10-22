<!-- SPDX-FileCopyrightText: 2026 Kaito Udagawa <umireon@kaito.tokyo> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Checklist status helper

Required lines are configured per repository in `src/checklist.mjs`. Matching
is literal and case-sensitive, with LF or CRLF line endings. Markdown structure,
signature validity, contributor identity, and attestations are not evaluated.

The GitHub App needs Pull requests: Read and Commit statuses: Read and write,
and must subscribe to Pull request webhooks. To enforce the result, configure
the `checklist` required status with this App as its expected source.

## Durable reconciliation

`opened`, `edited`, `synchronize`, `reopened`, `ready_for_review`, and `closed`
events enqueue a repository reconciliation. The webhook returns 204 only after
the `CHECKLIST_JOBS` Durable Object commits both the job and its alarm in one
storage transaction. Failure to enqueue returns 503 and is logged; failed
GitHub deliveries require redelivery because GitHub does not retry them automatically.

One object, keyed by repository ID, serializes all status writes using its alarm
handler. Each reconciliation fetches all pages of open PRs, groups them by head
SHA, and reports success only when every open PR sharing that SHA passes.
This includes drafts and PRs against different base branches. Closing an
unchecked PR allows the remaining PRs to pass on the next reconciliation.

Events arriving during reconciliation increment the persisted revision and
schedule another pass; completing older work cannot discard them. GitHub API
failures retain the job and retry after 30 seconds, with exponential backoff
capped at 15 minutes. Retries continue until successful, including across object
restarts. These are pending jobs, not an evidence ledger.

`cloudflare.config.ts` provisions the SQLite-backed `ChecklistJobs` class and its
binding on deployment. No additional external queue is required. Deploy this
configuration together with the Worker code.

The helper is eventually consistent: webhook delivery, API calls, and retries
introduce delay. There is no atomic transaction between a GitHub body edit,
status publication, and merge. A GitHub outage can delay correction of an old
status until a retry succeeds.
