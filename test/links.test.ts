import { describe, expect, it } from "vitest";
import { directionsLink, placeSearchLink } from "../src/services/maps/links";

describe("placeSearchLink", () => {
	it("builds a search link from a text query", () => {
		expect(placeSearchLink({ query: "Tim Ho Wan Sham Shui Po" })).toBe(
			"https://www.google.com/maps/search/?api=1&query=Tim+Ho+Wan+Sham+Shui+Po",
		);
	});

	it("pins the exact place with query_place_id", () => {
		expect(placeSearchLink({ query: "22.3193,114.1694", placeId: "ChIJtest123" })).toBe(
			"https://www.google.com/maps/search/?api=1&query=22.3193%2C114.1694&query_place_id=ChIJtest123",
		);
	});
});

describe("directionsLink", () => {
	it("builds a minimal destination-only link (origin = current location)", () => {
		expect(directionsLink({ destination: "Hong Kong International Airport" })).toBe(
			"https://www.google.com/maps/dir/?api=1&destination=Hong+Kong+International+Airport",
		);
	});

	it("includes travelmode, place ids, and dir_action=navigate", () => {
		const url = directionsLink({
			destination: "Tsim Sha Tsui",
			destinationPlaceId: "ChIJdest",
			origin: "Central, Hong Kong",
			travelmode: "transit",
			navigate: true,
		});
		const params = new URL(url).searchParams;
		expect(params.get("api")).toBe("1");
		expect(params.get("destination")).toBe("Tsim Sha Tsui");
		expect(params.get("destination_place_id")).toBe("ChIJdest");
		expect(params.get("origin")).toBe("Central, Hong Kong");
		expect(params.get("travelmode")).toBe("transit");
		expect(params.get("dir_action")).toBe("navigate");
	});

	it("drops origin_place_id when origin text is absent (Google requires the pair)", () => {
		const url = directionsLink({ destination: "X", originPlaceId: "ChIJorigin" });
		expect(url).not.toContain("origin_place_id");
	});
});
