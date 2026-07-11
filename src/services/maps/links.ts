/**
 * Google Maps URLs — universal cross-platform deep links.
 * https://developers.google.com/maps/documentation/urls/get-started
 *
 * Plain HTTPS links: on a phone with the Google Maps app they open the app,
 * elsewhere they fall back to the browser. Free, no API key.
 */

export type DeepLinkTravelMode = "driving" | "walking" | "bicycling" | "transit" | "two-wheeler";

/** Routes API travel mode → deep-link travelmode vocabulary. */
export const ROUTES_MODE_TO_DEEP_LINK: Record<string, DeepLinkTravelMode> = {
	DRIVE: "driving",
	WALK: "walking",
	BICYCLE: "bicycling",
	TRANSIT: "transit",
	TWO_WHEELER: "two-wheeler",
};

export function placeSearchLink(options: { query: string; placeId?: string }): string {
	const params = new URLSearchParams();
	params.set("api", "1");
	params.set("query", options.query);
	if (options.placeId) params.set("query_place_id", options.placeId);
	return `https://www.google.com/maps/search/?${params.toString()}`;
}

export function directionsLink(options: {
	destination: string;
	destinationPlaceId?: string;
	origin?: string;
	originPlaceId?: string;
	travelmode?: DeepLinkTravelMode;
	/** Launch turn-by-turn navigation (or route preview) immediately on open. */
	navigate?: boolean;
}): string {
	const params = new URLSearchParams();
	params.set("api", "1");
	params.set("destination", options.destination);
	// A *_place_id param requires its matching text param to also be present.
	if (options.destinationPlaceId) params.set("destination_place_id", options.destinationPlaceId);
	if (options.origin) {
		params.set("origin", options.origin);
		if (options.originPlaceId) params.set("origin_place_id", options.originPlaceId);
	}
	if (options.travelmode) params.set("travelmode", options.travelmode);
	if (options.navigate) params.set("dir_action", "navigate");
	return `https://www.google.com/maps/dir/?${params.toString()}`;
}
