/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { isAccountDeletionAllowed } from '@/utility/account-delete-policy.js';

describe('isAccountDeletionAllowed', () => {
	test.each([
		[{ canDeleteAccount: true }, true],
		[{ canDeleteAccount: false }, false],
		[{}, false],
		[{ canDeleteAccount: 'true' }, false],
		[{ canDeleteAccount: 1 }, false],
	])('allows only a typed true value', (policies, expected) => {
		expect(isAccountDeletionAllowed(policies)).toBe(expected);
	});
});
