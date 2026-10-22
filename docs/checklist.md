<!-- SPDX-FileCopyrightText: 2026 Kaito Udagawa <umireon@kaito.tokyo> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Checklist status helper

Required lines are configured per repository in `src/checklist.mjs`. Matching
is literal and case-sensitive, with LF or CRLF line endings. Markdown structure,
signature validity, contributor identity, and attestations are not evaluated.

The GitHub App needs Pull requests: Read and Commit statuses: Read and write,
and must subscribe to Pull request webhooks. To enforce the result, configure
the `checklist` required status with this App as its expected source.

## Status updates

`opened`, `edited`, `synchronize`, `reopened`, `ready_for_review`, and `closed`
events trigger a repository reconciliation. The webhook returns 204 immediately
and uses `waitUntil` to finish the GitHub API calls in the background.

Each reconciliation fetches all pages of open PRs, groups them by head
SHA, and reports success only when every open PR sharing that SHA passes.
This includes drafts and PRs against different base branches. Closing an
unchecked PR allows the remaining PRs to pass on the next reconciliation.

Updates are optimistic and best-effort. There is no serialization, durable
queue, or automatic retry. Concurrent events can finish out of order, and a
failed GitHub API request can leave the previous status in place. Background
errors are reported through Worker observability.

If a checklist update fails or leaves an outdated status, close and reopen the
PR to trigger a fresh check. This is an operational helper, not an atomic
merge-time enforcement mechanism. It does not collect evidence or attestations.
