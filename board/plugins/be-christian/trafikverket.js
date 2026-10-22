'use strict';
// Trafikverket TrafficFlow client. The key is read from process.env only and never returned or logged.
const URL_API = 'https://api.trafikinfo.trafikverket.se/v2/data.json';
const TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function round(n) { return Math.round(n * 1000) / 1000; }

async function flowNear(lat, lon, radiusM) {
  const key = process.env.TRAFIKVERKET_API_KEY;
  if (!key) return { status: 503, error: 'Trafikverket key is not configured on this server' };
  const ck = round(lat) + ',' + round(lon) + ',' + radiusM;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.t < TTL_MS) return hit.v;
  const xml = '<REQUEST><LOGIN authenticationkey="' + key + '"/>' +
    '<QUERY objecttype="TrafficFlow" schemaversion="1.5" limit="50">' +
    '<FILTER><WITHIN name="Geometry.WGS84" shape="center" value="' + lon + ' ' + lat + '" radius="' + radiusM + 'm"/></FILTER>' +
    '<INCLUDE>SiteId</INCLUDE><INCLUDE>MeasurementOrCalculationTime</INCLUDE><INCLUDE>VehicleFlowRate</INCLUDE>' +
    '<INCLUDE>AverageVehicleSpeed</INCLUDE><INCLUDE>VehicleType</INCLUDE><INCLUDE>SpecificLane</INCLUDE>' +
    '<INCLUDE>Geometry.WGS84</INCLUDE></QUERY></REQUEST>';
  let res;
  try {
    res = await fetch(URL_API, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: xml, signal: AbortSignal.timeout(10000) });
  } catch (e) {
    return { status: 502, error: 'Trafikverket unreachable' };
  }
  if (!res.ok) return { status: 502, error: 'Trafikverket answered ' + res.status };
  let json;
  try { json = await res.json(); } catch (e) { return { status: 502, error: 'Trafikverket sent invalid JSON' }; }
  const r = json && json.RESPONSE && json.RESPONSE.RESULT && json.RESPONSE.RESULT[0];
  const rows = (r && r.TrafficFlow) || [];
  const sites = {};
  for (const x of rows) {
    const s = sites[x.SiteId] || (sites[x.SiteId] = { siteId: x.SiteId, wgs84: x.Geometry && x.Geometry.WGS84, measurements: [] });
    s.measurements.push({
      time: x.MeasurementOrCalculationTime,
      vehiclesPerHour: x.VehicleFlowRate,
      avgSpeedKmh: x.AverageVehicleSpeed,
      vehicleType: x.VehicleType,
      lane: x.SpecificLane,
    });
  }
  const v = { status: 200, body: { source: 'Trafikverket TrafficFlow', center: { lat, lon }, radiusM, sites: Object.values(sites) } };
  cache.set(ck, { t: Date.now(), v });
  return v;
}

module.exports = { flowNear };
