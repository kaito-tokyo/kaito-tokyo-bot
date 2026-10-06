// SPDX-FileCopyrightText: 2026 Kaito Udagawa <umireon@kaito.tokyo>
//
// SPDX-License-Identifier: Apache-2.0

import packageJson from "../../package.json" with { type: "json" };

/**
 * The target installation and scope of an installation access token.
 *
 * @typedef {object} CreateInstallationAccessTokenOptions
 * @property {number} installationId - The GitHub App installation ID.
 * @property {number[]} repositoryIds - The repository IDs accessible with the token.
 * @property {Record<string, "read" | "write">} permissions - The permissions granted to the token.
 */

/**
 * A deployment protection rule review.
 *
 * @typedef {object} DeploymentProtectionRuleReview
 * @property {string} environmentName - The target GitHub Environment name.
 * @property {"approved" | "rejected"} state - The deployment decision.
 * @property {string} comment - The explanation of the decision.
 */

/** Sends authenticated requests to the GitHub REST API. */
export class GitHubClient {
	#apiBase = "https://api.github.com";
	#headers = {
		Accept: "application/vnd.github+json",
		"Content-Type": "application/json",
		"User-Agent": `${packageJson.name}/${packageJson.version}`,
		"X-GitHub-Api-Version": "2026-03-10",
	};

	/** @type {typeof globalThis.fetch} */
	#fetch;

	/**
	 * @param {typeof globalThis.fetch} _fetch - The fetch implementation used for API requests.
	 */
	constructor(_fetch = globalThis.fetch) {
		this.#fetch = _fetch.bind(globalThis);
	}

	/**
	 * Creates an installation access token scoped to the requested repositories and permissions.
	 *
	 * @param {string} appToken - The GitHub App JWT.
	 * @param {CreateInstallationAccessTokenOptions} options - The target installation and token scope.
	 * @returns {Promise<string>} The installation access token.
	 */
	async createInstallationAccessToken(appToken, { installationId, repositoryIds, permissions }) {
		const response = await this.#fetch(`${this.#apiBase}/app/installations/${installationId}/access_tokens`, {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(8000),
			headers: {
				...this.#headers,
				Authorization: `Bearer ${appToken}`,
			},
			body: JSON.stringify({ repository_ids: repositoryIds, permissions }),
		});
		if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
		const auth = await response.json();
		if (typeof auth.token !== "string" || !auth.token) throw new Error("Missing installation token");
		return auth.token;
	}

	/**
	 * Submits a deployment protection rule decision to the authenticated webhook's callback.
	 *
	 * @param {string} callbackUrl - The callback URL from the GitHub webhook payload.
	 * @param {string} installationToken - The installation access token.
	 * @param {DeploymentProtectionRuleReview} review - The deployment review.
	 * @returns {Promise<void>} Resolves when GitHub accepts the review.
	 */
	async reviewDeploymentProtectionRule(callbackUrl, installationToken, { environmentName, state, comment }) {
		const callback = new URL(callbackUrl);
		const response = await this.#fetch(`${this.#apiBase}${callback.pathname}`, {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(8000),
			headers: {
				...this.#headers,
				Authorization: `Bearer ${installationToken}`,
			},
			body: JSON.stringify({ environment_name: environmentName, state, comment }),
		});
		if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
	}
}
