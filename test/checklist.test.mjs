// SPDX-FileCopyrightText: 2026 Kaito Udagawa <umireon@kaito.tokyo>
//
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { evaluateChecklist, reconcileChecklists } from "../src/checklist.mjs";
import { handleGitHubWebhook } from "../src/index.mjs";
import { GitHubClient } from "../src/github/GitHubClient.mjs";

const repository = "kaito-tokyo/LDTX";
const first = "- [x] I have read the latest CONTRIBUTING.md.";
const second = "- [x] I have signed off and verified all my commits.";
const body = `${first}\n${second}`;

test("requires both exact lines, independently of order and surrounding text", () => {
	for (const text of [body, `Description\n${second}\n\n${first}\nOther`, body.replaceAll("\n", "\r\n")]) {
		assert.equal(evaluateChecklist(repository, text).approved, true);
	}
	for (const text of [null, "", first, second, body.replace("[x]", "[ ]"), body.replace("[x]", "[X]"), ` ${first}\n${second}`, `${first} \n${second}`, body.replace("CONTRIBUTING.md.", "CONTRIBUTING.md")]) {
		assert.equal(evaluateChecklist(repository, text).approved, false);
	}
	// Only line presence matters, including inside Markdown code fences.
	assert.equal(evaluateChecklist(repository, `\u0060\u0060\u0060\n${body}\n\u0060\u0060\u0060`).approved, true);
	assert.equal(evaluateChecklist("other/repo", body), null);
});

function webhook(payload, secret, signature) {
	const text = JSON.stringify(payload);
	return new Request("https://bot.kaito.tokyo/api/github/webhooks", {
		method: "POST", body: text,
		headers: {
			"X-GitHub-Event": "pull_request",
			"X-Hub-Signature-256": signature ?? `sha256=${createHmac("sha256", secret).update(text).digest("hex")}`,
		},
	});
}

const env = { GITHUB_CLIENT_ID: "client", GITHUB_PRIVATE_KEY: "unused", GITHUB_WEBHOOK_SECRET: "secret" };
const payload = {
	action: "edited", installation: { id: 1 },
	repository: { id: 2, full_name: repository }, pull_request: { number: 382, body: "outdated" },
};

test("shared SHA fails if any open PR is unchecked", async () => {
	for (const bodies of [[body, first], [first, body], [body, body]]) {
		const calls = [];
		await reconcileChecklists({ repository, repositoryId: 2, installationId: 1 }, env, {
			async createInstallationAccessToken() { return "token"; },
			async listOpenPullRequests() { return bodies.map((body) => ({ state: "open", body, head: { sha: "b".repeat(40) } })); },
			async setChecklistStatus(...args) { calls.push(args); },
		}, async () => "jwt");
		assert.deepEqual(calls, [[repository, "b".repeat(40), "token", bodies.every((text) => text === body)]]);
	}
});

for (const action of ["opened", "edited", "synchronize", "reopened", "ready_for_review", "closed"]) {
	test(`authenticated ${action} durably enqueues repository reconciliation`, async () => {
		const calls = [];
		const client = new GitHubClient(() => assert.fail("webhook must not process GitHub work"));
		const result = await handleGitHubWebhook(webhook({ ...payload, action }, "secret"), {
			...env,
			CHECKLIST_JOBS: {
				idFromName(name) { assert.equal(name, "2"); return name; },
				get(id) {
					assert.equal(id, "2");
					return { async fetch(url, options) {
						calls.push(JSON.parse(options.body));
						return new Response(null, { status: 204 });
					} };
				},
			},
		}, client);
		assert.equal(result.response.status, 204);
		await result.waitUntil;
		assert.deepEqual(calls, [{ repository, repositoryId: 2, installationId: 1 }]);
	});
}

test("ignores unconfigured repositories and irrelevant actions; rejects bad signatures and IDs", async () => {
	const client = new GitHubClient(() => assert.fail("unexpected API request"));
	for (const [value, signature, status] of [
		[{ ...payload, action: "labeled" }, undefined, 204],
		[{ ...payload, repository: { full_name: "other/repo" } }, undefined, 204],
		[{ ...payload, installation: { id: 0 } }, undefined, 400],
		[payload, "sha256=" + "0".repeat(64), 401],
	]) {
		const result = await handleGitHubWebhook(webhook(value, "secret", signature), env, client);
		assert.equal(result.response.status, status);
		await result.waitUntil;
	}
});

test("status API reports both outcomes and propagates failures", async () => {
	for (const approved of [true, false]) {
		const client = new GitHubClient(async (url, options) => {
			assert.equal(url, `https://api.github.com/repos/${repository}/statuses/${"a".repeat(40)}`);
			assert.equal(options.headers.Authorization, "Bearer token");
			assert.equal(options.method, "POST");
			const status = JSON.parse(options.body);
			assert.equal(status.context, "checklist");
			assert.equal(status.state, approved ? "success" : "failure");
			return new Response(null, { status: 201 });
		});
		await client.setChecklistStatus(repository, "a".repeat(40), "token", approved);
	}
	const failing = new GitHubClient(async () => new Response(null, { status: 403 }));
	await assert.rejects(failing.setChecklistStatus(repository, "a".repeat(40), "token", true), /403/);
	await assert.rejects(failing.listOpenPullRequests(repository, "token"), /403/);
});
