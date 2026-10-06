// SPDX-FileCopyrightText: 2026 Kaito Udagawa <umireon@kaito.tokyo>
//
// SPDX-License-Identifier: Apache-2.0

/// <reference path="../.cloudflare/types/index.d.ts" />

import { Buffer } from "node:buffer";
import { createGitHubAppToken } from "./github/app-token.mjs";
import { GitHubClient } from "./github/GitHubClient.mjs";
import { verifySignature } from "./github/webhook.mjs";
import { evaluateDeploymentProtectionRule } from "./rules.mjs";

/**
 * A webhook response and the work to continue after responding.
 *
 * @typedef {object} HandlerResult
 * @property {Response} response - The immediate HTTP response.
 * @property {Promise<void>} [waitUntil] - The background processing task.
 */

/**
 * Parses a UTF-8 encoded JSON buffer without throwing on parse failure.
 *
 * @param {Buffer} buffer - The buffer containing UTF-8 encoded JSON.
 * @returns {any} The parsed JSON value, or null if parsing fails.
 */
function parseJSON(buffer) {
	try {
		return JSON.parse(buffer.toString("utf8"));
	} catch {
		return null;
	}
}

/**
 * Reviews requested deployments using the authenticated webhook sender ID.
 *
 * @param {Buffer} body - The authenticated webhook request body.
 * @param {Env} env - The Worker secret bindings.
 * @param {GitHubClient} githubClient - The client used for GitHub API requests.
 * @returns {Promise<HandlerResult>} The response and background processing task.
 */
async function handleDeploymentProtectionRule(body, env, githubClient) {
	const payload = parseJSON(body);
	if (!payload) {
		console.error("Failed to parse JSON payload");
		return { response: new Response("Bad Request", { status: 400 }), waitUntil: Promise.resolve() };
	} else if (typeof payload !== "object") {
		console.error("Invalid payload");
		return { response: new Response("Bad Request", { status: 400 }), waitUntil: Promise.resolve() };
	}

	if (payload.action === "requested") {
		const installation = payload.installation?.id;
		const repositoryId = payload.repository?.id;
		const environment = payload.environment;
		const callbackStr = payload.deployment_callback_url;

		if (!Number.isSafeInteger(installation) || installation <= 0) {
			console.error("Invalid installation in protection rule payload");
			return { response: new Response("Bad Request", { status: 400 }), waitUntil: Promise.resolve() };
		} else if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
			console.error("Invalid repository ID in protection rule payload");
			return { response: new Response("Bad Request", { status: 400 }), waitUntil: Promise.resolve() };
		} else if (typeof environment !== "string") {
			console.error("Invalid environment in protection rule payload");
			return { response: new Response("Bad Request", { status: 400 }), waitUntil: Promise.resolve() };
		}

		const approved = evaluateDeploymentProtectionRule(environment, payload.sender?.id);
		const waitUntil = (async () => {
			const appToken = await createGitHubAppToken(env.GITHUB_CLIENT_ID, env.GITHUB_PRIVATE_KEY);
			const installationToken = await githubClient.createInstallationAccessToken(appToken, {
				installationId: installation,
				repositoryIds: [repositoryId],
				permissions: { deployments: "write" },
			});
			await githubClient.reviewDeploymentProtectionRule(callbackStr, installationToken, {
				environmentName: environment,
				state: approved ? "approved" : "rejected",
				comment: approved ? "Deployment protection rule passed." : "Deployment protection rule did not pass.",
			});
		})();
		return { response: new Response(null, { status: 204 }), waitUntil };
	} else {
		console.info("Ignoring unsupported deployment protection rule action");
		return { response: new Response(null, { status: 204 }), waitUntil: Promise.resolve() };
	}
}

/**
 * Handles authenticated GitHub webhooks and reviews deployment protection rules.
 *
 * @param {Request} request - The incoming GitHub webhook request.
 * @param {Env} env - The Worker secret bindings.
 * @param {GitHubClient} githubClient - The client used for GitHub API requests.
 * @returns {Promise<HandlerResult>} The response and background processing task.
 */
export async function handleGitHubWebhook(request, env, githubClient) {
	if (!env.GITHUB_CLIENT_ID) {
		console.error("GitHub Client ID is not configured");
		return { response: new Response("Internal Server Error", { status: 503 }), waitUntil: Promise.resolve() };
	} else if (!env.GITHUB_PRIVATE_KEY) {
		console.error("GitHub Private Key is not configured");
		return { response: new Response("Internal Server Error", { status: 503 }), waitUntil: Promise.resolve() };
	} else if (!env.GITHUB_WEBHOOK_SECRET) {
		console.error("GitHub webhook secret is not configured");
		return { response: new Response("Internal Server Error", { status: 503 }), waitUntil: Promise.resolve() };
	}

	if (request.method !== "POST") {
		return { response: new Response("Method not allowed", { status: 405, headers: { Allow: "POST" }}), waitUntil: Promise.resolve() };
	}

	const body = Buffer.from(await request.arrayBuffer());
	const signature = request.headers.get("X-Hub-Signature-256");
	if (!await verifySignature(body, signature, env.GITHUB_WEBHOOK_SECRET)) {
		return { response: new Response("Unauthorized", { status: 401 }), waitUntil: Promise.resolve() };
	}

	const event = request.headers.get("X-GitHub-Event");
	if (event === "ping") {
		console.info("Received ping event");
		return { response: new Response("Pong"), waitUntil: Promise.resolve() };
	} else if (event === "deployment_protection_rule") {
		console.info("Received deployment protection rule event");
		return await handleDeploymentProtectionRule(body, env, githubClient);
	} else {
		console.info("Ignoring unsupported event");
		return { response: new Response(null, { status: 204 }), waitUntil: Promise.resolve() };
	}
}

export default {
	/**
	 * Routes incoming Worker requests to the GitHub webhook handler.
	 *
	 * @param {Request} request - The incoming HTTP request.
	 * @param {Env} env - The Worker secret bindings.
	 * @param {ExecutionContext} ctx - The Worker execution context.
	 * @returns {Promise<Response>} The response to the request.
	 */
	async fetch(request, env, ctx) {
		const githubClient = new GitHubClient();
		const url = new URL(request.url);
		if (url.pathname == "/api/github/webhooks") {
			const { response, waitUntil } = await handleGitHubWebhook(request, env, githubClient);
			if (waitUntil) {
				ctx.waitUntil(waitUntil);
			}
			return response;
		} else {
			return new Response("Not found", { status: 404 });
		}
	},
};
