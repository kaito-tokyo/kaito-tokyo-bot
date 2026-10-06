// SPDX-FileCopyrightText: 2026 Kaito Udagawa <umireon@kaito.tokyo>
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Validates the signature against the exact bytes received from GitHub.
 *
 * @param {BufferSource} body - The unmodified webhook request body.
 * @param {string | null} signature - The X-Hub-Signature-256 header value.
 * @param {string} secret - The GitHub App webhook secret.
 * @returns {Promise<boolean>} Whether the signature is valid.
 */
export async function verifySignature(body, signature, secret) {
	if (!signature) return false;
	const match = /^sha256=([a-f0-9]{64})$/.exec(signature);
	if (!match) return false;
	const bytes = Uint8Array.from(
		match[1].match(/../g),
		(value) => Number.parseInt(value, 16),
	);
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	return crypto.subtle.verify("HMAC", key, bytes, body);
}
