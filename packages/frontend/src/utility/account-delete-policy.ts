/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function isAccountDeletionAllowed(policies: object): boolean {
	return (policies as Record<string, unknown>).canDeleteAccount === true;
}
