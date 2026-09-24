import { describe, expect, test } from 'vitest';
import { isAccountDeletionAllowed } from '@/utility/account-delete-policy.js';

describe('isAccountDeletionAllowed', () => {
	test.each([
		[{ canDeleteAccount: true }, true],
		[{ canDeleteAccount: false }, false],
		[{}, false],
		[{ canDeleteAccount: 'true' }, false],
	])('uses only a typed true value', (policies, expected) => {
		expect(isAccountDeletionAllowed(policies)).toBe(expected);
	});
});
