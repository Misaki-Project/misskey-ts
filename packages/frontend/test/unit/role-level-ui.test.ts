/*
 * SPDX-FileCopyrightText: Misaki Project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRoleLevelConfig } from '@/utility/role-level-api.js';

function findRepoRoot(): string {
	for (const start of [process.cwd(), dirname(fileURLToPath(import.meta.url))]) {
		let dir = start;
		for (;;) {
			if (existsSync(resolve(dir, 'locales', 'ja-JP.yml'))) return dir;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	throw new Error('repository root not found');
}

const root = findRepoRoot();
const read = (path: string) => readFileSync(resolve(root, ...path.split('/')), 'utf8');

describe('role-level default editor state', () => {
	test('matches the backend default curve and complete policy range', () => {
		expect(defaultRoleLevelConfig('role')).toEqual({
			roleId: 'role',
			baseLevel: 1,
			experienceCurve: [{ type: 'const', levelUps: 99, base: 100, additional: 0, exponential: 1 }],
			policyRanges: [{ type: 'base', start: 1, end: 101 }],
			revision: 0,
		});
	});
});

describe('role-level UI integration points', () => {
	test('plugin adapter keeps credentials out of strict request bodies', () => {
		const source = read('packages/frontend/src/utility/role-level-api.ts');
		expect(source).toContain('Authorization: `Bearer ${$i.token}`');
		expect(source).not.toContain('return misskeyApi(');
	});

	test.each([
		['admin role category', 'packages/frontend/src/pages/admin/roles.vue', 'plugin/role-level/admin/roles/list'],
		['role editor', 'packages/frontend/src/pages/admin/roles.edit.vue', 'plugin/role-level/admin/roles/update'],
		['profile badge', 'packages/frontend/src/pages/user/home.vue', 'plugin/role-level/users/show'],
		['admin user editor', 'packages/frontend/src/pages/admin-user.vue', 'plugin/role-level/admin/change-exp'],
		['profile visibility', 'packages/frontend/src/pages/settings/other.vue', 'plugin/role-level/users/profile-hide'],
	])('%s calls its plugin endpoint', (_name, path, endpoint) => {
		expect(read(path)).toContain(endpoint);
	});

	test('explore includes restored legacy level roles', () => {
		expect(read('packages/frontend/src/pages/explore.roles.vue')).toContain("(x.target as string) === 'manualLevel'");
	});

	test('the admin user page distinguishes deleted and suspended users', () => {
		const source = read('packages/frontend/src/pages/admin-user.vue');
		expect(source).toContain('v-if="deleted"');
		expect(source).toContain('v-if="suspended"');
	});
});
