import { afterEach, describe, expect, it, vi } from "vitest";
import {
	computeRoute,
	parseDurationSeconds,
	parseWaypoint,
	searchPlaces,
} from "../src/services/maps/client";
import { formatDistance, formatDuration } from "../src/services/maps/tools";
import { jsonResponse, stubFetch } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

describe("parseWaypoint", () => {
	it("parses lat,lng coordinates", () => {
		expect(parseWaypoint("22.3193, 114.1694")).toEqual({
			location: { latLng: { latitude: 22.3193, longitude: 114.1694 } },
		});
	});

	it("parses place_id: prefix", () => {
		expect(parseWaypoint("place_id:ChIJabc")).toEqual({ placeId: "ChIJabc" });
	});

	it("falls back to address", () => {
		expect(parseWaypoint("10 Downing Street, London")).toEqual({
			address: "10 Downing Street, London",
		});
	});
});

describe("parseDurationSeconds", () => {
	it("strips the trailing s", () => {
		expect(parseDurationSeconds("1620s")).toBe(1620);
	});

	it("throws on unexpected format", () => {
		expect(() => parseDurationSeconds("27 min")).toThrow(/duration format/);
	});
});

describe("formatDuration / formatDistance", () => {
	it("formats durations", () => {
		expect(formatDuration(1620)).toBe("27 min");
		expect(formatDuration(3600)).toBe("1 hr");
		expect(formatDuration(3900)).toBe("1 hr 5 min");
	});

	it("formats distances", () => {
		expect(formatDistance(850)).toBe("850 m");
		expect(formatDistance(8300)).toBe("8.3 km");
	});
});

describe("searchPlaces", () => {
	it("sends the field mask + api key and maps the response shape", async () => {
		const captured = stubFetch(
			jsonResponse(200, {
				places: [
					{
						id: "ChIJx",
						displayName: { text: "Ichiran", languageCode: "en" },
						formattedAddress: "Somewhere, HK",
						location: { latitude: 22.28, longitude: 114.15 },
						rating: 4.5,
						googleMapsUri: "https://maps.google.com/?cid=1",
						currentOpeningHours: { openNow: true },
					},
				],
			}),
		);

		const places = await searchPlaces("test-key", {
			query: "ramen",
			latitude: 22.2867,
			longitude: 114.1502,
			limit: 5,
		});

		const request = captured[0];
		expect(request.url.href).toBe("https://places.googleapis.com/v1/places:searchText");
		expect(request.method).toBe("POST");
		expect(request.headers.get("X-Goog-Api-Key")).toBe("test-key");
		expect(request.headers.get("X-Goog-FieldMask")).toContain("places.displayName");
		const body = request.body as {
			textQuery: string;
			locationBias: { circle: { center: { latitude: number } } };
		};
		expect(body.textQuery).toBe("ramen");
		expect(body.locationBias.circle.center.latitude).toBe(22.2867);

		expect(places).toEqual([
			{
				id: "ChIJx",
				name: "Ichiran",
				address: "Somewhere, HK",
				latitude: 22.28,
				longitude: 114.15,
				rating: 4.5,
				googleMapsUri: "https://maps.google.com/?cid=1",
				openNow: true,
			},
		]);
	});

	it("omits locationBias when no coordinates given", async () => {
		const captured = stubFetch(jsonResponse(200, { places: [] }));
		await searchPlaces("k", { query: "x" });
		expect((captured[0].body as Record<string, unknown>).locationBias).toBeUndefined();
	});

	it("surfaces upstream errors with status", async () => {
		stubFetch(jsonResponse(400, { error: { message: "Field mask required" } }));
		await expect(searchPlaces("k", { query: "x" })).rejects.toThrow(/HTTP 400/);
	});
});

describe("computeRoute", () => {
	it("parses duration and distance, applies traffic preference for DRIVE", async () => {
		const captured = stubFetch(
			jsonResponse(200, { routes: [{ duration: "1620s", distanceMeters: 8300 }] }),
		);

		const estimate = await computeRoute("k", {
			origin: "Central, Hong Kong",
			destination: "22.3,114.2",
			travelMode: "DRIVE",
			trafficAware: true,
		});

		expect(estimate).toEqual({ durationSeconds: 1620, distanceMeters: 8300 });
		const body = captured[0].body as {
			routingPreference: string;
			origin: unknown;
			destination: { location: { latLng: { latitude: number } } };
		};
		expect(captured[0].url.href).toBe("https://routes.googleapis.com/directions/v2:computeRoutes");
		expect(body.routingPreference).toBe("TRAFFIC_AWARE");
		expect(body.origin).toEqual({ address: "Central, Hong Kong" });
		expect(body.destination.location.latLng.latitude).toBe(22.3);
	});

	it("omits routingPreference for TRANSIT even when trafficAware requested", async () => {
		const captured = stubFetch(
			jsonResponse(200, { routes: [{ duration: "900s", distanceMeters: 5000 }] }),
		);
		await computeRoute("k", {
			origin: "A",
			destination: "B",
			travelMode: "TRANSIT",
			trafficAware: true,
		});
		expect((captured[0].body as Record<string, unknown>).routingPreference).toBeUndefined();
	});

	it("throws when no route is returned", async () => {
		stubFetch(jsonResponse(200, {}));
		await expect(computeRoute("k", { origin: "A", destination: "B" })).rejects.toThrow(
			/No route found/,
		);
	});
});
