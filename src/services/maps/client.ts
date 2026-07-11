import { UpstreamApiError } from "../types";

/**
 * Google Maps Platform REST clients (server-side, API key auth).
 * - Places API (New) text search: https://developers.google.com/maps/documentation/places/web-service/text-search
 * - Routes API computeRoutes: https://developers.google.com/maps/documentation/routes/compute_route_directions
 *
 * Both APIs REQUIRE an X-Goog-FieldMask header — omitting it is an HTTP 400.
 * Field masks are kept minimal on purpose: each extra field tier bumps the billing SKU.
 */

const PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";

const PLACES_FIELD_MASK = [
	"places.id",
	"places.displayName",
	"places.formattedAddress",
	"places.location",
	"places.rating",
	"places.googleMapsUri",
	"places.currentOpeningHours.openNow",
].join(",");

const ROUTES_FIELD_MASK = ["routes.duration", "routes.distanceMeters"].join(",");

export interface PlaceResult {
	id: string;
	name: string;
	address?: string;
	latitude?: number;
	longitude?: number;
	rating?: number;
	googleMapsUri?: string;
	openNow?: boolean;
}

export interface SearchPlacesParams {
	query: string;
	/** Bias results around this point. Without it Google falls back to the caller IP — a Cloudflare datacenter, i.e. useless. */
	latitude?: number;
	longitude?: number;
	radiusMeters?: number;
	limit?: number;
	languageCode?: string;
}

interface PlacesSearchResponse {
	places?: Array<{
		id: string;
		displayName?: { text?: string };
		formattedAddress?: string;
		location?: { latitude?: number; longitude?: number };
		rating?: number;
		googleMapsUri?: string;
		currentOpeningHours?: { openNow?: boolean };
	}>;
}

async function googleFetch<T>(
	url: string,
	apiKey: string,
	fieldMask: string,
	body: unknown,
): Promise<T> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Goog-Api-Key": apiKey,
			"X-Goog-FieldMask": fieldMask,
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		const detail = (await response.text()).slice(0, 500);
		throw new UpstreamApiError("Google Maps", response.status, detail);
	}
	return (await response.json()) as T;
}

export async function searchPlaces(
	apiKey: string,
	params: SearchPlacesParams,
): Promise<PlaceResult[]> {
	const body: Record<string, unknown> = {
		textQuery: params.query,
		pageSize: Math.min(Math.max(params.limit ?? 5, 1), 20),
		languageCode: params.languageCode ?? "en",
	};
	if (params.latitude !== undefined && params.longitude !== undefined) {
		body.locationBias = {
			circle: {
				center: { latitude: params.latitude, longitude: params.longitude },
				radius: params.radiusMeters ?? 3000,
			},
		};
	}

	const data = await googleFetch<PlacesSearchResponse>(
		PLACES_SEARCH_URL,
		apiKey,
		PLACES_FIELD_MASK,
		body,
	);
	return (data.places ?? []).map((place) => ({
		id: place.id,
		name: place.displayName?.text ?? "(unnamed)",
		address: place.formattedAddress,
		latitude: place.location?.latitude,
		longitude: place.location?.longitude,
		rating: place.rating,
		googleMapsUri: place.googleMapsUri,
		openNow: place.currentOpeningHours?.openNow,
	}));
}

export type RoutesTravelMode = "DRIVE" | "WALK" | "BICYCLE" | "TRANSIT" | "TWO_WHEELER";

/**
 * Parse a user-supplied waypoint string into the Routes API waypoint shape.
 * Accepts: "lat,lng" coordinates, "place_id:ChIJ..." place IDs, or a free-text address.
 */
export function parseWaypoint(input: string): Record<string, unknown> {
	const trimmed = input.trim();
	if (trimmed.startsWith("place_id:")) {
		return { placeId: trimmed.slice("place_id:".length) };
	}
	const coordMatch = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
	if (coordMatch) {
		return {
			location: {
				latLng: {
					latitude: Number.parseFloat(coordMatch[1]),
					longitude: Number.parseFloat(coordMatch[2]),
				},
			},
		};
	}
	return { address: trimmed };
}

export interface ComputeRouteParams {
	origin: string;
	destination: string;
	travelMode?: RoutesTravelMode;
	/** Live-traffic-aware duration (DRIVE/TWO_WHEELER only; pricier SKU). */
	trafficAware?: boolean;
	/** RFC 3339 timestamp; only meaningful with trafficAware. */
	departureTime?: string;
}

export interface RouteEstimate {
	durationSeconds: number;
	distanceMeters: number;
}

interface RoutesResponse {
	routes?: Array<{ duration?: string; distanceMeters?: number }>;
}

export function parseDurationSeconds(duration: string): number {
	const match = duration.match(/^(\d+(?:\.\d+)?)s$/);
	if (!match) throw new Error(`Unexpected Routes API duration format: ${duration}`);
	return Number.parseFloat(match[1]);
}

export async function computeRoute(
	apiKey: string,
	params: ComputeRouteParams,
): Promise<RouteEstimate> {
	const travelMode = params.travelMode ?? "DRIVE";
	const body: Record<string, unknown> = {
		origin: parseWaypoint(params.origin),
		destination: parseWaypoint(params.destination),
		travelMode,
		units: "METRIC",
	};
	// routingPreference is only valid for DRIVE / TWO_WHEELER.
	if (params.trafficAware && (travelMode === "DRIVE" || travelMode === "TWO_WHEELER")) {
		body.routingPreference = "TRAFFIC_AWARE";
		if (params.departureTime) body.departureTime = params.departureTime;
	}

	const data = await googleFetch<RoutesResponse>(ROUTES_URL, apiKey, ROUTES_FIELD_MASK, body);
	const route = data.routes?.[0];
	if (!route?.duration || route.distanceMeters === undefined) {
		throw new UpstreamApiError("Google Maps", 200, "No route found between origin and destination");
	}
	return {
		durationSeconds: parseDurationSeconds(route.duration),
		distanceMeters: route.distanceMeters,
	};
}
