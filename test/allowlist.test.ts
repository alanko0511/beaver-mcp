import { describe, expect, it } from "vitest";
import { isLoginAllowed, parseAllowedLogins } from "../src/auth/allowlist";

describe("parseAllowedLogins", () => {
	it("splits on commas, trims, lowercases, drops empties", () => {
		expect(parseAllowedLogins(" Alice , bob,,CAROL ")).toEqual(new Set(["alice", "bob", "carol"]));
	});

	it("returns an empty set for undefined or empty input", () => {
		expect(parseAllowedLogins(undefined).size).toBe(0);
		expect(parseAllowedLogins("").size).toBe(0);
	});
});

describe("isLoginAllowed", () => {
	it("matches case-insensitively", () => {
		expect(isLoginAllowed("Alice", "alice")).toBe(true);
		expect(isLoginAllowed("alice", "ALICE,bob")).toBe(true);
	});

	it("fails closed: empty allowlist denies everyone", () => {
		expect(isLoginAllowed("alice", "")).toBe(false);
		expect(isLoginAllowed("alice", undefined)).toBe(false);
	});

	it("denies missing login", () => {
		expect(isLoginAllowed(undefined, "alice")).toBe(false);
	});
});
