/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';
import unitConfig from './vitest.config.unit.js';

const require = createRequire(import.meta.url);

// Build-time plugins live outside this package and own their regression tests.
export default defineConfig({
	...unitConfig,
	resolve: {
		...unitConfig.resolve,
		alias: {
			...unitConfig.resolve?.alias,
			'@testing-library/vue': require.resolve('@testing-library/vue'),
		},
	},
	test: {
		...unitConfig.test,
		include: ['../../../../plugins/*/frontend/*.test.ts'],
	},
});
