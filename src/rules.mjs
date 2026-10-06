// SPDX-FileCopyrightText: 2026 Kaito Udagawa <umireon@kaito.tokyo>
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Allows umireon to deploy to apple-deployment and rejects all other cases.
 *
 * @param {string} environment - The target GitHub Environment name.
 * @param {number | undefined} senderId - The sender's GitHub user ID from the authenticated webhook payload.
 * @returns {boolean} Whether the deployment is allowed.
 */
export function evaluateDeploymentProtectionRule(environment, senderId) {
	// Keep this mapping inside the function and never expose its reference,
	// so external code cannot modify the allowed sender IDs.
	const knownSenderIds = {
		umireon: 1067855,
	};

	switch (environment) {
		case "apple-deployment":
			if (senderId === knownSenderIds.umireon) {
				return true;
			} else {
				return false;
			}
		default:
			return false;
	}
}
