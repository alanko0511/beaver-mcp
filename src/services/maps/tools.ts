import { z } from "zod";
import { widgets } from "../../generated/widgets";
import { defineTool, jsonResult, type ServiceModule, textResult } from "../types";
import { computeRoute, type RoutesTravelMode, searchPlaces } from "./client";
import { directionsLink, placeSearchLink, ROUTES_MODE_TO_DEEP_LINK } from "./links";

const MAP_WIDGET_URI = "ui://beaver/map-search.html";

const DEEP_LINK_MODES = ["driving", "walking", "bicycling", "transit", "two-wheeler"] as const;
const ROUTES_MODES = ["DRIVE", "WALK", "BICYCLE", "TRANSIT", "TWO_WHEELER"] as const;

export function formatDuration(totalSeconds: number): string {
	const minutes = Math.round(totalSeconds / 60);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

export function formatDistance(meters: number): string {
	if (meters < 1000) return `${Math.round(meters)} m`;
	return `${(meters / 1000).toFixed(1)} km`;
}

const searchPlacesTool = defineTool({
	name: "search_places",
	description:
		"Search Google Maps for places by keyword (restaurants, shops, addresses, landmarks...). " +
		"Renders an interactive map widget with markers where supported; the JSON result includes, per place, " +
		"the place_id, coordinates, rating, open-now status, a Google Maps link (mapsUrl) and a directions " +
		"deep link (directionsUrl) that opens the Google Maps app on a phone. " +
		"Pass latitude/longitude to bias results near a location — otherwise results are biased by the server's datacenter IP, not the user.",
	inputSchema: {
		query: z
			.string()
			.describe("What to search for, e.g. 'ramen in Sheung Wan' or 'pharmacy near Times Square'"),
		latitude: z.number().min(-90).max(90).optional().describe("Bias search around this latitude"),
		longitude: z
			.number()
			.min(-180)
			.max(180)
			.optional()
			.describe("Bias search around this longitude"),
		radius_meters: z
			.number()
			.int()
			.min(100)
			.max(50000)
			.optional()
			.describe("Bias radius in meters (default 3000)"),
		limit: z.number().int().min(1).max(20).default(5).describe("Max results"),
	},
	annotations: { title: "Search places", readOnlyHint: true },
	widget: { resourceUri: MAP_WIDGET_URI },
	handler: async (args, { env }) => {
		const places = await searchPlaces(env.GOOGLE_MAPS_API_KEY, {
			query: args.query,
			latitude: args.latitude,
			longitude: args.longitude,
			radiusMeters: args.radius_meters,
			limit: args.limit,
		});

		const results = places.map((place) => ({
			name: place.name,
			address: place.address,
			rating: place.rating,
			openNow: place.openNow,
			latitude: place.latitude,
			longitude: place.longitude,
			placeId: place.id,
			mapsUrl: place.googleMapsUri ?? placeSearchLink({ query: place.name, placeId: place.id }),
			directionsUrl: directionsLink({
				destination: place.address ?? place.name,
				destinationPlaceId: place.id,
			}),
		}));

		return jsonResult({ query: args.query, places: results });
	},
});

const getNavigationLinkTool = defineTool({
	name: "get_navigation_link",
	description:
		"Build a Google Maps directions deep link (no API cost). The link is tappable on a phone and opens " +
		"the Google Maps app ready to navigate — ideal to send to yourself via messaging. " +
		"Omit origin to use the phone's current location. Set navigate=true to launch turn-by-turn immediately.",
	inputSchema: {
		destination: z.string().describe("Destination: place name, address, or 'lat,lng'"),
		destination_place_id: z
			.string()
			.optional()
			.describe("Google place_id for the destination (from search_places) — pins the exact place"),
		origin: z.string().optional().describe("Start point; omit for the device's current location"),
		travelmode: z.enum(DEEP_LINK_MODES).default("driving"),
		navigate: z
			.boolean()
			.default(false)
			.describe("true → the app launches turn-by-turn navigation on open"),
	},
	annotations: { title: "Navigation link", readOnlyHint: true },
	handler: async (args) => {
		const url = directionsLink({
			destination: args.destination,
			destinationPlaceId: args.destination_place_id,
			origin: args.origin,
			travelmode: args.travelmode,
			navigate: args.navigate,
		});
		return textResult(`[Directions to ${args.destination}](${url})\n\n${url}`);
	},
});

const estimateTravelTimeTool = defineTool({
	name: "estimate_travel_time",
	description:
		"Estimate travel time and distance between two points via the Google Routes API (no turn-by-turn). " +
		"Origin/destination accept a free-text address, 'lat,lng' coordinates, or 'place_id:<id>' from search_places. " +
		"Set traffic_aware=true for live-traffic driving estimates (costs more, DRIVE only).",
	inputSchema: {
		origin: z.string().describe("Start: address, 'lat,lng', or 'place_id:<id>'"),
		destination: z.string().describe("End: address, 'lat,lng', or 'place_id:<id>'"),
		mode: z.enum(ROUTES_MODES).default("DRIVE"),
		traffic_aware: z
			.boolean()
			.default(false)
			.describe("Use live traffic for the estimate (DRIVE / TWO_WHEELER only)"),
		departure_time: z
			.string()
			.optional()
			.describe("RFC 3339 departure time, e.g. 2026-07-11T09:00:00Z; only with traffic_aware"),
	},
	annotations: { title: "Estimate travel time", readOnlyHint: true },
	handler: async (args, { env }) => {
		const estimate = await computeRoute(env.GOOGLE_MAPS_API_KEY, {
			origin: args.origin,
			destination: args.destination,
			travelMode: args.mode as RoutesTravelMode,
			trafficAware: args.traffic_aware,
			departureTime: args.departure_time,
		});
		const mode = args.mode.toLowerCase().replace("_", "-");
		const link = directionsLink({
			destination: args.destination.replace(/^place_id:/, ""),
			origin: args.origin.startsWith("place_id:") ? undefined : args.origin,
			travelmode: ROUTES_MODE_TO_DEEP_LINK[args.mode],
		});
		return textResult(
			`${formatDuration(estimate.durationSeconds)} (${formatDistance(estimate.distanceMeters)}) by ${mode}` +
				`${args.traffic_aware ? " with live traffic" : ""}\n\nOpen in Google Maps: ${link}`,
		);
	},
});

export const mapsService: ServiceModule = {
	name: "maps",
	tools: [searchPlacesTool, getNavigationLinkTool, estimateTravelTimeTool],
	resources: [
		{
			name: "Map search widget",
			uri: MAP_WIDGET_URI,
			description: "Interactive Google Map showing search_places results",
			html: (env) =>
				widgets["map-search"].replace("__GOOGLE_MAPS_BROWSER_KEY__", env.GOOGLE_MAPS_BROWSER_KEY),
			csp: {
				resourceDomains: [
					"https://maps.googleapis.com",
					"https://maps.gstatic.com",
					"https://fonts.googleapis.com",
					"https://fonts.gstatic.com",
				],
				connectDomains: ["https://maps.googleapis.com", "https://maps.gstatic.com"],
			},
		},
	],
};
