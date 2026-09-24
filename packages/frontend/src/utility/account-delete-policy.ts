export function isAccountDeletionAllowed(policies: object): boolean {
	return (policies as Record<string, unknown>).canDeleteAccount === true;
}
