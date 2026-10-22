// SPDX-FileCopyrightText: 2026 Kaito Udagawa <umireon@kaito.tokyo>
//
// SPDX-License-Identifier: Apache-2.0

const checklists = {
	"kaito-tokyo/LDTX": [
		"- [x] I have read the latest CONTRIBUTING.md.",
		"- [x] I have signed off and verified all my commits.",
	],
};

/** Returns null for repositories without a configured checklist. */
export function evaluateChecklist(repository, body) {
	if (!Object.hasOwn(checklists, repository)) return null;
	const lines = new Set((body ?? "").split(/\r?\n/));
	const missing = checklists[repository].filter((line) => !lines.has(line));
	return { approved: missing.length === 0, missing };
}

/** Handles checklist events independently of deployment protection. */
export async function handleChecklist(payload, env, githubClient, createAppToken) {
	if (!["opened", "edited", "synchronize", "reopened", "ready_for_review", "closed"].includes(payload?.action)) {
		return { response: new Response(null, { status: 204 }) };
	}
	const repository = payload.repository?.full_name;
	if (evaluateChecklist(repository, "") === null) {
		return { response: new Response(null, { status: 204 }) };
	}
	const installationId = payload.installation?.id;
	const repositoryId = payload.repository?.id;
	const number = payload.pull_request?.number;
	if (![installationId, repositoryId, number].every((id) => Number.isSafeInteger(id) && id > 0)) {
		return { response: new Response("Bad Request", { status: 400 }) };
	}
	// Best-effort updates: reopening a PR triggers another attempt after failure.
	const waitUntil = reconcileChecklists({ repository, repositoryId, installationId }, env, githubClient, createAppToken);
	return { response: new Response(null, { status: 204 }), waitUntil };
}

/** Reconciles every open PR: a shared SHA succeeds only if all its PRs pass. */
export async function reconcileChecklists(job, env, githubClient, createAppToken) {
	const appToken = await createAppToken(env.GITHUB_CLIENT_ID, env.GITHUB_PRIVATE_KEY);
	const token = await githubClient.createInstallationAccessToken(appToken, {
		installationId: job.installationId, repositoryIds: [job.repositoryId],
		permissions: { pull_requests: "read", statuses: "write" },
	});
	const pulls = await githubClient.listOpenPullRequests(job.repository, token);
	const results = new Map();
	for (const pr of pulls) {
		if (pr.state !== "open" || typeof pr.head?.sha !== "string" || !/^[a-f0-9]{40}$/.test(pr.head.sha)
			|| (pr.body !== null && typeof pr.body !== "string")) {
			throw new Error("Invalid pull request response");
		}
		const approved = evaluateChecklist(job.repository, pr.body)?.approved === true;
		results.set(pr.head.sha, (results.get(pr.head.sha) ?? true) && approved);
	}
	for (const [sha, approved] of results) {
		await githubClient.setChecklistStatus(job.repository, sha, token, approved);
	}
}
