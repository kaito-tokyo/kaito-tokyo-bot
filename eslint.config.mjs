// SPDX-FileCopyrightText: 2026 Kaito Udagawa <umireon@kaito.tokyo>
//
// SPDX-License-Identifier: Apache-2.0

import js from "@eslint/js";
import globals from "globals";

export default [
	{ ignores: [".cloudflare/**", ".wrangler/**", "dist/**"] },
	js.configs.recommended,
	{
		files: ["test/**/*.mjs"],
		languageOptions: { globals: globals.node },
	},
	{
		files: ["src/**/*.mjs"],
		languageOptions: {
			globals: globals.worker,
		},
	},
];
