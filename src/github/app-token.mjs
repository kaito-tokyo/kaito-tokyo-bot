// SPDX-FileCopyrightText: 2026 Kaito Udagawa <umireon@kaito.tokyo>
//
// SPDX-License-Identifier: Apache-2.0

import { importPKCS8, SignJWT } from "jose";

/**
 * Creates an RS256 JWT for authenticating as a GitHub App.
 *
 * @param {string} clientId - The GitHub App client ID.
 * @param {string} privateKey - The GitHub App's PKCS#8 PEM private key.
 * @returns {Promise<string>} A signed JWT that expires in four minutes.
 */
export async function createGitHubAppToken(clientId, privateKey) {
	const key = await importPKCS8(privateKey, "RS256");
	return new SignJWT({})
		.setProtectedHeader({ alg: "RS256", typ: "JWT" })
		.setIssuedAt("-1m")
		.setExpirationTime("4m")
		.setIssuer(clientId)
		.sign(key);
}
