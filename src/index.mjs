// SPDX-FileCopyrightText: 2026 Kaito Udagawa <umireon@kaito.tokyo>
//
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createGitHubAppToken } from "./github/app-token.mjs";
import { verifySignature } from "./github/webhook.mjs";

const API = "https://api.github.com";

/** Calls GitHub without following redirects or exposing tokens in errors. */
async function github(path, token, options = {}, request = globalThis.fetch) {
	const response = await request(`${API}${path}`, {
		...options,
		redirect: "error",
		signal: AbortSignal.timeout(8000),
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"User-Agent": "kaito-tokyo-bot",
			"X-GitHub-Api-Version": "2026-03-10",
		},
	});
	if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
	return response.status === 204 ? null : response.json();
}

/** Reviews the workflow's original actor, including for re-runs. */
async function review(payload, env, request) {
	const owner = payload.repository?.owner?.login;
	const repo = payload.repository?.name;
	const installation = payload.installation?.id;
	if (!owner || !repo || !Number.isSafeInteger(installation) || installation <= 0 ||
		!Number.isSafeInteger(payload.repository?.id) || typeof payload.environment !== "string") {
		throw new Error("Invalid protection rule payload");
	}
	const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/`;
	const callback = new URL(payload.deployment_callback_url);
	const match = callback.pathname.slice(base.length).match(/^([1-9][0-9]*)\/deployment_protection_rule$/);
	if (callback.origin !== API || !callback.pathname.startsWith(base) || !match ||
		callback.search || callback.hash || callback.username || callback.password) {
		throw new Error("Invalid deployment callback URL");
	}
	const appToken = await createGitHubAppToken(env.GITHUB_CLIENT_ID, env.GITHUB_PRIVATE_KEY);
	const auth = await github(`/app/installations/${installation}/access_tokens`, appToken, {
		method: "POST",
		body: JSON.stringify({
			repository_ids: [payload.repository.id],
			permissions: { actions: "read", deployments: "write" },
		}),
	}, request);
	if (typeof auth.token !== "string" || !auth.token) throw new Error("Missing installation token");
	const run = await github(`${base}${match[1]}`, auth.token, {}, request);
	const actor = run.actor?.login;
	const approved = typeof actor === "string" && actor.toLowerCase() === "umireon";
	await github(callback.pathname, auth.token, {
		method: "POST",
		body: JSON.stringify({
			environment_name: payload.environment,
			state: approved ? "approved" : "rejected",
			comment: approved ? "Workflow actor umireon is allowed." : "Workflow actor is not allowed; only umireon may deploy.",
		}),
	}, request);
}

/** Handles authenticated GitHub deployment protection rule webhooks. */
export async function handleWebhook(request, env, githubFetch = globalThis.fetch) {
	if (new URL(request.url).pathname !== "/api/github/webhooks") return new Response("Not found", { status: 404 });
	if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
	if (!env.GITHUB_WEBHOOK_SECRET) return new Response("Webhook secret is not configured", { status: 503 });
	const body = Buffer.from(await request.arrayBuffer());
	if (!await verifySignature(body, request.headers.get("X-Hub-Signature-256"), env.GITHUB_WEBHOOK_SECRET)) {
		return new Response("Invalid signature", { status: 401 });
	}
	let payload;
	try {
		payload = JSON.parse(body.toString("utf8"));
	} catch {
		return new Response("Invalid JSON", { status: 400 });
	}
	if (!payload || typeof payload !== "object") return new Response("Invalid payload", { status: 400 });
	if (request.headers.get("X-GitHub-Event") === "ping") return new Response("Pong");
	if (request.headers.get("X-GitHub-Event") !== "deployment_protection_rule" || payload.action !== "requested") {
		return new Response(null, { status: 204 });
	}
	if (!env.GITHUB_CLIENT_ID || !env.GITHUB_PRIVATE_KEY) return new Response("GitHub App is not configured", { status: 503 });
	try {
		await review(payload, env, githubFetch);
		return new Response(null, { status: 204 });
	} catch {
		console.error("Deployment protection rule review failed");
		return new Response("Deployment review failed", { status: 500 });
	}
}

export default {
	fetch(request, env) {
		return handleWebhook(request, env);
	},
};
