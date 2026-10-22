// SPDX-FileCopyrightText: 2026 Kaito Udagawa <umireon@kaito.tokyo>
//
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { ChecklistJobs } from "../src/ChecklistJobs.mjs";
import { handleChecklist, reconcileChecklists } from "../src/checklist.mjs";
import { GitHubClient } from "../src/github/GitHubClient.mjs";

const repository = "kaito-tokyo/LDTX";
const body = "- [x] I have read the latest CONTRIBUTING.md.\n- [x] I have signed off and verified all my commits.";
const sha = "a".repeat(40);
const job = { repository, repositoryId: 2, installationId: 1 };
const payload = { action: "edited", repository: { id: 2, full_name: repository }, installation: { id: 1 }, pull_request: { number: 382 } };
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = { GITHUB_CLIENT_ID: "client", GITHUB_PRIVATE_KEY: keys.privateKey.export({ type: "pkcs8", format: "pem" }) };
const pull = (text = body) => ({ state: "open", body: text, head: { sha } });

function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

// Rollback and serialized transactions model the durable storage boundary.
class MemoryStorage {
	values = new Map();
	alarm = null;
	async get(key) { return structuredClone(this.values.get(key)); }
	async put(key, value) { this.values.set(key, structuredClone(value)); }
	async delete(key) { this.values.delete(key); }
	async setAlarm(time) { this.alarm = time; }
	async deleteAlarm() { this.alarm = null; }
	transactions = Promise.resolve();
	transaction(fn) {
		const result = this.transactions.then(async () => {
			const before = structuredClone(this.values);
			const alarm = this.alarm;
			try { return await fn(this); } catch (error) {
				this.values = before;
				this.alarm = alarm;
				throw error;
			}
		});
		this.transactions = result.catch(() => {});
		return result;
	}
}
const enqueue = (queue) => queue.fetch(new Request("https://checklist/enqueue", { method: "POST", body: JSON.stringify(job) }));

function githubMock(t, { list = async () => [pull()], status = async () => {}, token = async () => {} } = {}) {
	t.mock.method(globalThis, "fetch", async (url, options) => {
		if (url.includes("/access_tokens")) {
			await token();
			assert.deepEqual(JSON.parse(options.body), { repository_ids: [2], permissions: { pull_requests: "read", statuses: "write" } });
			return Response.json({ token: "token" });
		}
		if (url.includes("/pulls?")) return Response.json(await list());
		assert.equal(url, `https://api.github.com/repos/${repository}/statuses/${sha}`);
		await status(JSON.parse(options.body).state);
		return new Response(null, { status: 201 });
	});
}

test("webhook waits for durable enqueue and returns 503 on persistence failure", async (t) => {
	t.mock.method(console, "error", () => {});
	const entered = deferred();
	const persisted = deferred();
	let acknowledged = false;
	const task = handleChecklist(payload, {
		CHECKLIST_JOBS: { idFromName: () => "2", get: () => ({ async fetch() {
			entered.resolve();
			await persisted.promise;
			return new Response(null, { status: 204 });
		} }) },
	}).then((result) => { acknowledged = true; return result; });
	await entered.promise;
	assert.equal(acknowledged, false);
	persisted.resolve();
	assert.equal((await task).response.status, 204);
	for (const fetch of [async () => { throw new Error("storage unavailable"); }, async () => new Response(null, { status: 500 })]) {
		const result = await handleChecklist(payload, { CHECKLIST_JOBS: { idFromName: () => "2", get: () => ({ fetch }) } });
		assert.equal(result.response.status, 503);
	}
});

test("edit during in-flight write stays queued and final result is current failure", async (t) => {
	const storage = new MemoryStorage();
	const queue = new ChecklistJobs({ storage }, env);
	const writing = deferred();
	const release = deferred();
	let currentBody = body;
	const states = [];
	githubMock(t, {
		list: async () => [pull(currentBody)],
		status: async (state) => {
			if (states.length === 0) { writing.resolve(); await release.promise; }
			states.push(state);
		},
	});
	await enqueue(queue);
	const earlier = queue.alarm();
	await writing.promise;
	currentBody = "unchecked";
	await enqueue(queue);
	release.resolve();
	await earlier;
	assert.ok(await storage.get("job"), "new event must survive completion of old work");
	assert.ok(storage.alarm !== null);
	// Restart: progress survives, unlike an in-memory promise chain.
	await new ChecklistJobs({ storage }, env).alarm();
	assert.deepEqual(states, ["success", "failure"]);
	assert.equal(await storage.get("job"), undefined);
	assert.equal(storage.alarm, null);
});

for (const stage of ["token", "list", "status"]) {
	test(`${stage} failure retries beyond platform limits and survives restart`, async (t) => {
		t.mock.method(console, "error", () => {});
		const storage = new MemoryStorage();
		let fail = true;
		const states = [];
		const maybeFail = () => { if (fail) throw new Error("GitHub timeout"); };
		githubMock(t, {
			token: async () => { if (stage === "token") maybeFail(); },
			list: async () => { if (stage === "list") maybeFail(); return [pull("unchecked")]; },
			status: async (state) => { if (stage === "status") maybeFail(); states.push(state); },
		});
		await enqueue(new ChecklistJobs({ storage }, env));
		for (let i = 0; i < 8; i++) await new ChecklistJobs({ storage }, env).alarm();
		assert.ok(await storage.get("job"));
		assert.ok(storage.alarm > Date.now());
		fail = false;
		await new ChecklistJobs({ storage }, env).alarm();
		assert.deepEqual(states, ["failure"]);
		assert.equal(await storage.get("job"), undefined);
	});
}

test("enqueue is atomic with retry scheduling", async () => {
	const storage = new MemoryStorage();
	storage.setAlarm = async () => { throw new Error("storage failure"); };
	await assert.rejects(enqueue(new ChecklistJobs({ storage }, env)), /storage failure/);
	assert.equal(await storage.get("job"), undefined);
});

test("all pages are read before publishing a shared-SHA status", async () => {
	const pages = [];
	const statuses = [];
	const client = new GitHubClient(async (url, options) => {
		if (url.includes("/access_tokens")) return Response.json({ token: "token" });
		if (url.includes("/pulls?")) {
			const page = Number(new URL(url).searchParams.get("page"));
			pages.push(page);
			return Response.json(page === 1 ? Array.from({ length: 100 }, () => pull()) : [pull("unchecked")]);
		}
		statuses.push(JSON.parse(options.body));
		return new Response(null, { status: 201 });
	});
	await reconcileChecklists(job, env, client, async () => "jwt");
	assert.deepEqual(pages, [1, 2]);
	assert.equal(statuses.length, 1);
	assert.equal(statuses[0].state, "failure");
});

test("malformed API state does not publish partial successes", async () => {
	await assert.rejects(reconcileChecklists(job, env, {
		async createInstallationAccessToken() { return "token"; },
		async listOpenPullRequests() { return [pull(), { ...pull(), head: { sha: "invalid" } }]; },
		async setChecklistStatus() { assert.fail("must validate all PRs before publishing"); },
	}, async () => "jwt"), /Invalid pull request/);
});
