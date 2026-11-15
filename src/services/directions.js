/**
 * In-app directions: the app asks our API, the API asks Google Routes API.
 * The server key (GOOGLE_MAPS_SERVER_KEY) never leaves the server.
 */
const config = require('../config');
const { AppError, badRequest } = require('../lib/errors');
const { parse, z } = require('../lib/util');

const MODES = { drive: 'DRIVE', walk: 'WALK', two_wheeler: 'TWO_WHEELER', bicycle: 'BICYCLE' };

const schema = z.object({
  fromLat: z.coerce.number().min(-90).max(90),
  fromLng: z.coerce.number().min(-180).max(180),
  toLat: z.coerce.number().min(-90).max(90),
  toLng: z.coerce.number().min(-180).max(180),
  mode: z.enum(Object.keys(MODES)).default('drive'),
});

const FIELDS = [
  'routes.distanceMeters',
  'routes.duration',
  'routes.polyline.encodedPolyline',
  'routes.legs.steps.distanceMeters',
  'routes.legs.steps.staticDuration',
  'routes.legs.steps.navigationInstruction',
].join(',');

const seconds = (d) => (typeof d === 'string' ? Math.round(Number.parseFloat(d)) || 0 : 0);

async function route(query, fetchImpl = fetch) {
  const q = parse(schema, query);
  if (!config.maps.serverKey) {
    throw new AppError(503, 'directions_unavailable', 'Directions are not set up on the server yet');
  }
  const point = (lat, lng) => ({ location: { latLng: { latitude: lat, longitude: lng } } });
  const body = {
    origin: point(q.fromLat, q.fromLng),
    destination: point(q.toLat, q.toLng),
    travelMode: MODES[q.mode],
    polylineQuality: 'HIGH_QUALITY',
    languageCode: 'en',
    units: 'METRIC',
  };
  if (q.mode === 'drive' || q.mode === 'two_wheeler') body.routingPreference = 'TRAFFIC_AWARE';

  let res;
  try {
    res = await fetchImpl('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': config.maps.serverKey, 'X-Goog-FieldMask': FIELDS },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    throw new AppError(502, 'directions_failed', 'Could not reach the directions service');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.warn(`Directions: Google returned ${res.status}: ${json?.error?.message || ''}`);
    if (res.status === 400) throw badRequest('directions_invalid', 'No route could be calculated for these points');
    throw new AppError(502, 'directions_failed', 'The directions service is not available right now');
  }
  const r = json.routes?.[0];
  if (!r) throw new AppError(404, 'route_not_found', `No ${q.mode.replace('_', ' ')} route found to this event`);

  const steps = (r.legs || []).flatMap((leg) => leg.steps || []).map((s) => ({
    instruction: s.navigationInstruction?.instructions || '',
    maneuver: s.navigationInstruction?.maneuver || null,
    distanceMeters: s.distanceMeters || 0,
    durationSeconds: seconds(s.staticDuration),
  })).filter((s) => s.instruction);

  return {
    mode: q.mode,
    distanceMeters: r.distanceMeters || 0,
    durationSeconds: seconds(r.duration),
    polyline: r.polyline?.encodedPolyline || '',
    steps,
  };
}

module.exports = { route, MODES };
