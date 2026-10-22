// SPDX-FileCopyrightText: 2026 Kaito Udagawa <umireon@kaito.tokyo>
//
// SPDX-License-Identifier: Apache-2.0

import { reconcileChecklists } from "./checklist.mjs";
import { createGitHubAppToken } from "./github/app-token.mjs";
import { GitHubClient } from "./github/GitHubClient.mjs";

/** One durable queue per repository, with a single serialized alarm consumer. */
export class ChecklistJobs {
	constructor(ctx, env) {
		this.storage = ctx.storage;
		this.env = env;
	}

	async fetch(request) {
		const job = await request.json();
		await this.storage.transaction(async (txn) => {
			const previous = await txn.get("job");
			await txn.put("job", { ...job, revision: (previous?.revision ?? 0) + 1, attempts: 0 });
			await txn.setAlarm(Date.now() + 1);
		});
		return new Response(null, { status: 204 });
	}

	async alarm() {
		// Cloudflare runs at most one alarm handler at a time per object, including
		// retries. Requests can enqueue during network I/O, but never publish.
		const job = await this.storage.get("job");
		if (!job) return;
		try {
			await reconcileChecklists(job, this.env, new GitHubClient(), createGitHubAppToken);
			await this.storage.transaction(async (txn) => {
				const current = await txn.get("job");
				if (current.revision === job.revision) {
					await txn.delete("job");
					await txn.deleteAlarm();
				} else {
					// An edit arrived during the scan/write: fetch fresh state again.
					await txn.setAlarm(Date.now() + 1);
				}
			});
		} catch (error) {
			console.error("Checklist reconciliation failed; retrying", error);
			// Persist retries indefinitely, rather than exhausting platform retries.
			await this.storage.transaction(async (txn) => {
				const current = await txn.get("job");
				const attempts = Math.min(current.attempts + 1, 6);
				await txn.put("job", { ...current, attempts });
				await txn.setAlarm(Date.now() + Math.min(30_000 * 2 ** (attempts - 1), 900_000));
			});
		}
	}
}
