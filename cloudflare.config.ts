// SPDX-FileCopyrightText: 2026 Kaito Udagawa <umireon@kaito.tokyo>
//
// SPDX-License-Identifier: Apache-2.0

import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.mjs" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "kaito-tokyo-bot",
		compatibilityDate: "2026-10-01",
		entrypoint,
		compatibilityFlags: ["nodejs_compat"],
		domains: ["bot.kaito.tokyo"],
		workersDev: false,
		observability: {
			enabled: true,
		},
		env: {
			GITHUB_APP_ID: bindings.secret(),
			GITHUB_CLIENT_ID: bindings.secret(),
			GITHUB_PRIVATE_KEY: bindings.secret(),
			GITHUB_WEBHOOK_SECRET: bindings.secret(),
		},
	},
});
