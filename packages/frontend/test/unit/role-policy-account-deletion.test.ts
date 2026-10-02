/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEYS = ['canDeleteAccount', 'canPurgeAccount'] as const;

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
const read = (path: string): string => readFileSync(resolve(root, ...path.split('/')), 'utf8');
const roleEditor = read('packages/frontend/src/pages/admin/roles.editor.vue');
const policyEditor = read('packages/frontend/src/pages/admin/roles.policy-editor.vue');
const rolesPage = read('packages/frontend/src/pages/admin/roles.vue');
const settingsPage = read('packages/frontend/src/pages/settings/other.vue');
const locale = read('locales/ja-JP.yml');
const generatedLocale = read('packages/i18n/src/autogen/locale.ts');

function parseKeyList(source: string, name: string): { keys: string[]; looped: boolean } {
	const declaration = new RegExp(`const\\s+${name}\\s*:[^=]*=\\s*\\[\\s*\\.\\.\\.Misskey\\.rolePolicies\\s*,([^\\]]*)\\]`).exec(source);
	if (declaration === null) throw new Error(`${name} declaration not found`);
	return {
		keys: [...declaration[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map(match => match[1]),
		looped: new RegExp(`for\\s*\\(\\s*const\\s+[A-Za-z0-9_]+\\s+of\\s+${name}\\b`).test(source),
	};
}

describe('account deletion policies in role editors', () => {
	test.each(KEYS)('%s is initialized and its metadata is restored', key => {
		const values = parseKeyList(roleEditor, 'mkGoRolePolicyKeys');
		const metadata = parseKeyList(policyEditor, 'mkGoPolicyMetaKeys');
		expect(values.keys).toContain(key);
		expect(values.looped).toBe(true);
		expect(metadata.keys).toContain(key);
		expect(metadata.looped).toBe(true);
	});

	test.each(KEYS)('%s has a value, metadata, and editor with backend default true', key => {
		expect(policyEditor).toMatch(new RegExp(`mkGoPolicyValue\\('${key}',\\s*true\\)`));
		expect(policyEditor).toMatch(new RegExp(`mkGoPolicyMeta\\('${key}'\\)`));
		expect(policyEditor).toMatch(new RegExp(`matchQuery\\(\\[i18n\\.ts\\._mkgoRolePolicy\\.${key},\\s*'${key}'\\]\\)`));
		expect(policyEditor).toContain(`v-model:policyMeta="${key}Meta"`);
	});

	test('base and assigned role save paths retain the extended policy maps', () => {
		expect(rolesPage).toContain('v-model:rolePolicies="policies"');
		expect(rolesPage).toContain("const policies = reactive(deepClone(instance.policies));");
		expect(rolesPage).toMatch(/admin\/roles\/update-default-policies[\s\S]*?policies,/);
		expect(roleEditor).toContain('Object.entries(role.value.policies)');
		expect(roleEditor).toContain('policies: role.value.policies');
	});
});

describe('account deletion policy presentation', () => {
	test.each(KEYS)('%s has generated label and caption keys', key => {
		expect(locale).toMatch(new RegExp(`^\\s{2}${key}:\\s*"\\S`, 'm'));
		expect(locale).toMatch(new RegExp(`^\\s{2}${key}_caption:\\s*"\\S`, 'm'));
		expect(generatedLocale).toMatch(new RegExp(`"${key}":\\s*string;`));
		expect(generatedLocale).toMatch(new RegExp(`"${key}_caption":\\s*string;`));
	});

	test('self-delete visibility depends only on canDeleteAccount', () => {
		expect(settingsPage).toContain("import { isAccountDeletionAllowed } from '@/utility/account-delete-policy.js';");
		expect(settingsPage).toMatch(/<SearchMarker\s+v-if="isAccountDeletionAllowed\(\$i\.policies\)"/);
		expect(settingsPage).not.toContain('canPurgeAccount');
	});
});
