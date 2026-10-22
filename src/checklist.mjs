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
	if (!["opened", "edited", "synchronize", "reopened", "ready_for_review"].includes(payload?.action)) {
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
	const waitUntil = (async () => {
		const appToken = await createAppToken(env.GITHUB_CLIENT_ID, env.GITHUB_PRIVATE_KEY);
		const token = await githubClient.createInstallationAccessToken(appToken, {
			installationId, repositoryIds: [repositoryId],
			permissions: { pull_requests: "read", statuses: "write" },
		});
		// Read current state so delayed or redelivered events do not replay old bodies.
		const pr = await githubClient.getPullRequest(repository, number, token);
		if (pr.state !== "open") return;
		if (typeof pr.head?.sha !== "string" || !/^[a-f0-9]{40}$/.test(pr.head.sha)
			|| (pr.body !== null && typeof pr.body !== "string")) {
			throw new Error("Invalid pull request response");
		}
		const result = evaluateChecklist(repository, pr.body);
		await githubClient.setChecklistStatus(repository, pr.head.sha, token, result.approved);
	})();
	return { response: new Response(null, { status: 204 }), waitUntil };
}
