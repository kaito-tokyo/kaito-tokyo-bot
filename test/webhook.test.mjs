// SPDX-FileCopyrightText: 2026 Kaito Udagawa <umireon@kaito.tokyo>
//
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { Buffer } from "node:buffer";
import test from "node:test";
import { handleGitHubWebhook } from "../src/index.mjs";
import { GitHubClient } from "../src/github/GitHubClient.mjs";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = {
	GITHUB_CLIENT_ID: "Iv1.test-client-id",
	GITHUB_PRIVATE_KEY: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
	GITHUB_WEBHOOK_SECRET: "test-secret",
};
const payload = {
	action: "requested",
	environment: "apple-deployment",
	installation: { id: 1 },
	repository: { id: 2, name: "repo", owner: { login: "owner" } },
	deployment_callback_url: "https://api.github.com/repos/owner/repo/actions/runs/3/deployment_protection_rule",
	sender: { id: 1067855, login: "umireon" },
};
function webhook(value = payload, signature) {
	const body = JSON.stringify(value);
	return new Request("https://bot.kaito.tokyo/api/github/webhooks", {
		method: "POST", body,
		headers: {
			"X-GitHub-Event": "deployment_protection_rule",
			"X-Hub-Signature-256": signature ?? `sha256=${createHmac("sha256", env.GITHUB_WEBHOOK_SECRET).update(body).digest("hex")}`,
		},
	});
}

for (const [environment, sender, expected] of [
	["apple-deployment", { id: 1067855, login: "umireon" }, "approved"],
	["apple-deployment", { id: 1067855, login: "renamed-user" }, "approved"],
	["apple-deployment", { id: 123, login: "umireon" }, "rejected"],
	["apple-deployment", { id: "1067855", login: "umireon" }, "rejected"],
	["apple-deployment", undefined, "rejected"],
	["preview", { id: 1067855, login: "umireon" }, "rejected"],
]) {
	test(`sender ${JSON.stringify(sender)} in ${environment} is ${expected}`, async () => {
		let calls = 0;
		const githubClient = new GitHubClient(async (url, options) => {
			calls++;
			if (calls === 1) {
				assert.equal(url, "https://api.github.com/app/installations/1/access_tokens");
				const [header, claims, signature] = options.headers.Authorization.slice(7).split(".");
				assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
				const jwtClaims = JSON.parse(Buffer.from(claims, "base64url"));
				assert.equal(jwtClaims.iss, "Iv1.test-client-id");
				assert.equal(Object.hasOwn(jwtClaims, "aud"), false);
				assert.equal(jwtClaims.exp - jwtClaims.iat, 300);
				assert.ok(jwtClaims.iat <= Date.now() / 1000);
				assert.ok(jwtClaims.exp > Date.now() / 1000);
				assert.ok(verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), keys.publicKey, Buffer.from(signature, "base64url")));
				assert.deepEqual(JSON.parse(options.body), { repository_ids: [2], permissions: { deployments: "write" } });
				return Response.json({ token: "test-token" });
			}
			assert.equal(calls, 2);
			assert.equal(options.method, "POST");
			assert.equal(url, payload.deployment_callback_url);
			assert.equal(JSON.parse(options.body).state, expected);
			assert.equal(JSON.parse(options.body).environment_name, environment);
			return new Response(null, { status: 204 });
		});
		const result = await handleGitHubWebhook(webhook({ ...payload, environment, sender }), env, githubClient);
		assert.equal(result.status, 204);
		assert.equal(calls, 2);
	});
}

test("invalid signature never calls GitHub", async () => {
	const githubClient = new GitHubClient(() => assert.fail("API called"));
	const result = await handleGitHubWebhook(webhook(payload, `sha256=${"0".repeat(64)}`), env, githubClient);
	assert.equal(result.status, 401);
});

test("GitHub API failure never approves a deployment", async () => {
	let calls = 0;
	const githubClient = new GitHubClient(async () => {
		calls++;
		return new Response(null, { status: 403 });
	});
	await assert.rejects(
		handleGitHubWebhook(webhook(), env, githubClient),
		{ message: "GitHub API returned 403" },
	);
	assert.equal(calls, 1);
});
