/**
 * Access is restricted to the GitHub logins listed in the ALLOWED_GITHUB_LOGINS
 * secret (comma-separated). The value lives in a Worker secret — never in code —
 * because this repo is public.
 *
 * An empty/missing secret denies everyone: fail closed.
 */

export function parseAllowedLogins(raw: string | undefined): Set<string> {
	return new Set(
		(raw ?? "")
			.split(",")
			.map((login) => login.trim().toLowerCase())
			.filter((login) => login.length > 0),
	);
}

export function isLoginAllowed(login: string | undefined, raw: string | undefined): boolean {
	if (!login) return false;
	return parseAllowedLogins(raw).has(login.toLowerCase());
}
