import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CircleMarker,
  MapContainer,
  Polyline,
  Popup,
  TileLayer,
  Tooltip as LeafletTooltip,
  ZoomControl,
  useMap,
} from 'react-leaflet';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import API_BASE_URL from '../config/api.js';
import { useIntelligence } from '../context/IntelligenceContext.jsx';

// Popular Bengaluru location presets within monitoring bounds
const BENGALURU_PRESETS = [
  { name: 'MG Road (Central)', lat: 12.9716, lon: 77.5946 },
  { name: 'BTM Layout (South)', lat: 12.9166, lon: 77.6101 },
  { name: 'Silk Board (South-East)', lat: 12.9177, lon: 77.6238 },
  { name: 'Hebbal (North)', lat: 13.0354, lon: 77.5988 },
  { name: 'Jayanagar 5th Block (South)', lat: 12.9208, lon: 77.5842 },
  { name: 'Peenya Industrial Area (North-West)', lat: 13.0285, lon: 77.5197 },
  { name: 'Kasturi Nagar (East)', lat: 13.0039, lon: 77.6642 },
  { name: 'Bapuji Nagar (West)', lat: 12.9568, lon: 77.5397 },
  { name: 'Hombegowda Nagar (South-Central)', lat: 12.9375, lon: 77.5949 },
  { name: 'RVCE-Mailasandra (South-West)', lat: 12.9231, lon: 77.5002 },
  { name: 'Jigani (Far South)', lat: 12.7816, lon: 77.6299 },
];

const WEEKDAYS = [
  { value: 0, label: 'Monday' },
  { value: 1, label: 'Tuesday' },
  { value: 2, label: 'Wednesday' },
  { value: 3, label: 'Thursday' },
  { value: 4, label: 'Friday' },
  { value: 5, label: 'Saturday' },
  { value: 6, label: 'Sunday' },
];

// Color palette for distinct alternative routes
const ROUTE_PALETTE = [
  { stroke: '#67D8B0', glow: 'rgba(103, 216, 176, 0.4)', name: 'Route 1' },
  { stroke: '#70C0E8', glow: 'rgba(112, 192, 232, 0.4)', name: 'Route 2' },
  { stroke: '#E5C07B', glow: 'rgba(229, 192, 123, 0.4)', name: 'Route 3' },
];

// Helper to auto-fit map view to route coordinates
function MapAutoFit({ coordinates }) {
  const map = useMap();

  useEffect(() => {
    if (!coordinates || coordinates.length === 0) return;
    const lats = coordinates.map((c) => c[1]);
    const lons = coordinates.map((c) => c[0]);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);

    map.fitBounds(
      [
        [minLat, minLon],
        [maxLat, maxLon],
      ],
      { padding: [45, 45], maxZoom: 14 }
    );
  }, [coordinates, map]);

  return null;
}

export default function PollutionRoutes() {
  const { liveAqi, navigateTo, syncCount } = useIntelligence();
  // Exposure calculation mode: 'live' or 'historical'
  const [routeMode, setRouteMode] = useState('live');

  // Origin & Destination coordinates
  const [originLat, setOriginLat] = useState('12.9716');
  const [originLon, setOriginLon] = useState('77.5946');
  const [destLat, setDestLat] = useState('12.9166');
  const [destLon, setDestLon] = useState('77.6101');

  // Departure Time
  const [departureHour, setDepartureHour] = useState(8);
  const [departureWeekday, setDepartureWeekday] = useState(0);

  // Results State
  const [routeResult, setRouteResult] = useState(null);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchRoutes = useCallback(async (forcedMode = routeMode) => {
    const oLat = parseFloat(originLat);
    const oLon = parseFloat(originLon);
    const dLat = parseFloat(destLat);
    const dLon = parseFloat(destLon);

    if (isNaN(oLat) || isNaN(oLon) || isNaN(dLat) || isNaN(dLon)) {
      setError('Please provide valid decimal numeric coordinates.');
      return;
    }

    if (Math.abs(oLat - dLat) < 0.0005 && Math.abs(oLon - dLon) < 0.0005) {
      setError('Origin and destination coordinates are too close to each other.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_BASE_URL}/routes/recommend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin_lat: oLat,
          origin_lon: oLon,
          destination_lat: dLat,
          destination_lon: dLon,
          departure_hour: parseInt(departureHour, 10),
          departure_weekday: parseInt(departureWeekday, 10),
          mode: forcedMode,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || 'Failed to calculate pollution-aware routes.');
      }

      setRouteResult(data);
      setSelectedRouteIndex(data.recommended_route_index ?? 0);
    } catch (err) {
      setError(err.message || 'Could not connect to the route recommendation service.');
      setRouteResult(null);
    } finally {
      setLoading(false);
    }
  }, [originLat, originLon, destLat, destLon, departureHour, departureWeekday, routeMode]);

  // Load route when inputs change or when global sync triggers
  useEffect(() => {
    queueMicrotask(() => {
      fetchRoutes();
    });
  }, [fetchRoutes, syncCount]);

  function handleOriginPreset(e) {
    const val = e.target.value;
    if (!val) return;
    const preset = BENGALURU_PRESETS.find((p) => p.name === val);
    if (preset) {
      setOriginLat(preset.lat.toString());
      setOriginLon(preset.lon.toString());
    }
  }

  function handleDestPreset(e) {
    const val = e.target.value;
    if (!val) return;
    const preset = BENGALURU_PRESETS.find((p) => p.name === val);
    if (preset) {
      setDestLat(preset.lat.toString());
      setDestLon(preset.lon.toString());
    }
  }

  function handleSwap() {
    setOriginLat(destLat);
    setOriginLon(destLon);
    setDestLat(originLat);
    setDestLon(originLon);
  }

  const selectedRoute = useMemo(() => {
    if (!routeResult || !routeResult.routes) return null;
    return (
      routeResult.routes.find((r) => r.route_index === selectedRouteIndex) ||
      routeResult.routes[0]
    );
  }, [routeResult, selectedRouteIndex]);

  // All coordinates from all alternative routes to center the map
  const allRouteCoords = useMemo(() => {
    if (!routeResult || !routeResult.routes) return [];
    return routeResult.routes.flatMap(
      (r) => r.geometry?.coordinates || []
    );
  }, [routeResult]);

  return (
    <section className="routes-page">
      {/* Intro Header */}
      <div className="citywide-intro">
        <div>
          <span className="citywide-kicker">DECISION INTELLIGENCE · ACT</span>
          <h2>Cleanest vs. Fastest Driving Routes.</h2>
          <p>
            Evaluate road alternatives in Bengaluru by estimated historical PM₂.₅ exposure,
            interpolated from active CPCB/KSPCB monitors along your travel corridor.
          </p>
        </div>
        <div className="citywide-intro-actions">
          <button
            type="button"
            className="intelligence-pill-btn"
            onClick={() => navigateTo('Map')}
            title="View monitoring stations on map"
          >
            Explore Monitoring Stations ⌖
          </button>
          <button
            type="button"
            className="intelligence-pill-btn"
            onClick={() => navigateTo('Forecast')}
            title="Check next-hour air quality forecast"
          >
            Check Next-Hour Forecast ⌁
          </button>
        </div>
      </div>

      {/* Decision Intelligence Context Banner */}
      <div className="live-distinction-banner" style={{ marginBottom: 18 }}>
        <span className="distinction-badge">DECISION TELEMETRY CONTEXT</span>
        <p>
          <strong>Ambient Telemetry Baseline:</strong> Central Bengaluru sits at{' '}
          <strong>{liveAqi?.pollutants?.pm2_5?.value != null ? `${Number(liveAqi.pollutants.pm2_5.value).toFixed(1)} µg/m³` : '24.0 µg/m³'} PM₂.₅</strong>{' '}
          (Open-Meteo atmospheric model). Route evaluations calculate cumulative exposure proxy along OSRM roadway segments.
          {routeMode === 'live'
            ? ' Currently using live atmospheric grid estimates sampled at 500m intervals.'
            : ' Currently using historical CPCB ground-station baseline for your specified departure schedule.'}
        </p>
      </div>

      {/* Input Configuration Panel */}
      <article className="panel routes-form-panel">
        <div className="panel-heading" style={{ flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <h3>Route parameters</h3>
            <p>Select origin, destination, departure timing, and calculation engine</p>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button
              type="button"
              className={`intelligence-pill-btn ${routeMode === 'live' ? 'active-pill' : ''}`}
              style={{
                background: routeMode === 'live' ? 'rgba(103, 216, 176, 0.2)' : 'rgba(255,255,255,0.05)',
                borderColor: routeMode === 'live' ? '#67D8B0' : '#2A3C34',
                color: routeMode === 'live' ? '#67D8B0' : '#A7B9AF',
              }}
              onClick={() => {
                setRouteMode('live');
                fetchRoutes('live');
              }}
            >
              ● Live Atmospheric Telemetry
            </button>
            <button
              type="button"
              className={`intelligence-pill-btn ${routeMode === 'historical' ? 'active-pill' : ''}`}
              style={{
                background: routeMode === 'historical' ? 'rgba(112, 192, 232, 0.2)' : 'rgba(255,255,255,0.05)',
                borderColor: routeMode === 'historical' ? '#70C0E8' : '#2A3C34',
                color: routeMode === 'historical' ? '#70C0E8' : '#A7B9AF',
              }}
              onClick={() => {
                setRouteMode('historical');
                fetchRoutes('historical');
              }}
            >
              ◷ Historical CPCB Baseline
            </button>
          </div>
        </div>

        <div className="routes-form-grid">
          {/* Origin Section */}
          <div className="route-input-group">
            <div className="route-group-header">
              <span className="route-point-badge origin-badge">A</span>
              <strong>ORIGIN (START)</strong>
            </div>
            <label className="route-field-label">
              Preset location
              <select onChange={handleOriginPreset} defaultValue="MG Road (Central)">
                <option value="">Choose a Bengaluru landmark…</option>
                {BENGALURU_PRESETS.map((p) => (
                  <option key={`orig-${p.name}`} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="route-coords-row">
              <label>
                Latitude
                <input
                  type="text"
                  value={originLat}
                  onChange={(e) => setOriginLat(e.target.value)}
                  placeholder="12.9716"
                />
              </label>
              <label>
                Longitude
                <input
                  type="text"
                  value={originLon}
                  onChange={(e) => setOriginLon(e.target.value)}
                  placeholder="77.5946"
                />
              </label>
            </div>
          </div>

          {/* Swap Button Column */}
          <div className="route-swap-container">
            <button
              type="button"
              className="route-swap-button"
              onClick={handleSwap}
              title="Swap origin and destination"
              aria-label="Swap origin and destination"
            >
              ⇄
            </button>
          </div>

          {/* Destination Section */}
          <div className="route-input-group">
            <div className="route-group-header">
              <span className="route-point-badge dest-badge">B</span>
              <strong>DESTINATION (END)</strong>
            </div>
            <label className="route-field-label">
              Preset location
              <select onChange={handleDestPreset} defaultValue="BTM Layout (South)">
                <option value="">Choose a Bengaluru landmark…</option>
                {BENGALURU_PRESETS.map((p) => (
                  <option key={`dest-${p.name}`} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="route-coords-row">
              <label>
                Latitude
                <input
                  type="text"
                  value={destLat}
                  onChange={(e) => setDestLat(e.target.value)}
                  placeholder="12.9166"
                />
              </label>
              <label>
                Longitude
                <input
                  type="text"
                  value={destLon}
                  onChange={(e) => setDestLon(e.target.value)}
                  placeholder="77.6101"
                />
              </label>
            </div>
          </div>

          {/* Departure Timing Section */}
          <div className="route-input-group timing-group">
            <div className="route-group-header">
              <span className="route-point-badge time-badge">⏱</span>
              <strong>DEPARTURE SCHEDULE</strong>
            </div>
            <div className="route-coords-row">
              <label>
                Day of week
                <select
                  value={departureWeekday}
                  onChange={(e) => setDepartureWeekday(parseInt(e.target.value, 10))}
                >
                  {WEEKDAYS.map((w) => (
                    <option key={w.value} value={w.value}>
                      {w.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Departure hour (IST)
                <select
                  value={departureHour}
                  onChange={(e) => setDepartureHour(parseInt(e.target.value, 10))}
                >
                  {Array.from({ length: 24 }).map((_, h) => (
                    <option key={h} value={h}>
                      {h.toString().padStart(2, '0')}:00 – {h.toString().padStart(2, '0')}:59
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button
              type="button"
              className="primary-button route-submit-btn"
              onClick={() => fetchRoutes()}
              disabled={loading}
            >
              {loading ? 'Evaluating road routes…' : `Calculate ${routeMode === 'live' ? 'Live-Exposure' : 'Historical'} Routes`}
            </button>
          </div>
        </div>
      </article>

      {/* Error Display */}
      {error && (
        <div className="model-warning routes-error" style={{ marginTop: 20 }}>
          <strong>Could not evaluate routes</strong>
          <p>{error}</p>
          <button
            type="button"
            className="primary-button"
            onClick={() => fetchRoutes()}
            style={{ marginTop: 8 }}
          >
            Retry Request
          </button>
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="panel citywide-loading" style={{ marginTop: 22 }}>
          <div className="citywide-loader" />
          <p>
            Requesting alternative driving geometries from OSRM and computing{' '}
            {routeMode === 'live'
              ? 'live Open-Meteo atmospheric exposure along sampled road coordinates…'
              : 'historical CPCB inverse-distance weighted PM₂.₅ exposure at 500-meter intervals…'}
          </p>
        </div>
      )}

      {/* Route Results Display */}
      {routeResult && !loading && (
        <>
          {/* Fallback Warning Banner if API was unreachable */}
          {routeResult.fallback_used && (
            <div
              className="model-warning"
              style={{
                marginTop: 20,
                background: 'rgba(215, 182, 109, 0.12)',
                borderColor: '#D7B66D',
                color: '#F4E5BE',
              }}
            >
              <strong>⚠️ HISTORICAL FALLBACK ACTIVE</strong>
              <p style={{ marginTop: 4 }}>
                {routeResult.fallback_warning ||
                  'Live atmospheric telemetry could not be retrieved for sampled coordinates. Displaying historical CPCB baseline calculations.'}
              </p>
            </div>
          )}

          {/* Comparative Analysis & Trade-off Banner */}
          <article className="panel tradeoff-banner" style={{ marginTop: 22 }}>
            <div className="tradeoff-content">
              <div className="tradeoff-icon">⚖</div>
              <div className="tradeoff-text">
                <span className="tradeoff-label">ROUTE COMPARISON & TRADE-OFF SUMMARY</span>
                <p>{routeResult.tradeoff_summary}</p>
              </div>
            </div>
            <div className="tradeoff-meta">
              <span>{routeResult.departure_context?.time_window}</span>
              <span>·</span>
              <span>{routeResult.departure_context?.departure_weekday_name}</span>
              <span>·</span>
              {routeResult.is_live ? (
                <span
                  className="tradeoff-disclaimer-pill"
                  style={{
                    background: 'rgba(103, 216, 176, 0.15)',
                    color: '#67D8B0',
                    border: '1px solid rgba(103, 216, 176, 0.35)',
                  }}
                >
                  LIVE ATMOSPHERIC EXPOSURE
                </span>
              ) : (
                <span className="tradeoff-disclaimer-pill">HISTORICAL CPCB BASELINE</span>
              )}
            </div>
          </article>

          {/* Spatial Resolution & Data Source Disclosure */}
          {routeResult.spatial_resolution_note && (
            <div
              className="panel"
              style={{
                marginTop: 14,
                padding: '12px 18px',
                background: 'rgba(18, 28, 24, 0.7)',
                border: '1px solid #24352D',
                borderRadius: '8px',
                fontSize: '12px',
                lineHeight: 1.5,
                color: '#A2B5AC',
              }}
            >
              <strong style={{ color: '#EAF5EF' }}>ℹ Methodology & Sensor Disclosure:</strong>{' '}
              {routeResult.spatial_resolution_note}
            </div>
          )}

          {/* Alternative Routes Grid (Interactive Cards) */}
          <div className="routes-cards-grid" style={{ marginTop: 20 }}>
            {routeResult.routes.map((route, idx) => {
              const isSelected = selectedRouteIndex === route.route_index;
              const palette = ROUTE_PALETTE[idx % ROUTE_PALETTE.length];

              return (
                <article
                  key={`route-card-${route.route_index}`}
                  className={`panel route-card ${isSelected ? 'active-route-card' : ''}`}
                  onClick={() => setSelectedRouteIndex(route.route_index)}
                >
                  <div className="route-card-top">
                    <div className="route-card-title">
                      <span
                        className="route-color-indicator"
                        style={{ background: palette.stroke }}
                      />
                      <strong>Route {route.route_index + 1}</strong>
                      <span className="route-summary-text">{route.summary}</span>
                    </div>

                    <div className="route-badges">
                      {route.is_cleanest && (
                        <span className="route-badge badge-cleanest">
                          ★ CLEANEST ROUTE
                        </span>
                      )}
                      {route.is_fastest && (
                        <span className="route-badge badge-fastest">
                          ⚡ FASTEST ROUTE
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="route-metrics-row">
                    <div className="route-metric">
                      <span className="route-metric-label">
                        {routeResult.is_live ? 'LIVE ESTIMATED PM₂.₅' : 'HISTORICAL PM₂.₅'}
                      </span>
                      <div className="route-metric-val">
                        {route.estimated_mean_pm25.toFixed(2)}
                        <span> µg/m³</span>
                      </div>
                      {routeResult.is_live && route.historical_mean_pm25 != null && (
                        <span style={{ fontSize: '11px', color: '#7F938B', display: 'block', marginTop: '2px' }}>
                          Hist baseline: {route.historical_mean_pm25.toFixed(1)} µg/m³
                        </span>
                      )}
                    </div>

                    <div className="route-metric">
                      <span className="route-metric-label">TRAVEL TIME</span>
                      <div className="route-metric-val">
                        {route.duration_min.toFixed(1)}
                        <span> min</span>
                      </div>
                    </div>

                    <div className="route-metric">
                      <span className="route-metric-label">DISTANCE</span>
                      <div className="route-metric-val">
                        {route.distance_km.toFixed(2)}
                        <span> km</span>
                      </div>
                    </div>

                    <div className="route-metric">
                      <span className="route-metric-label">
                        {routeResult.is_live ? 'LIVE CUMULATIVE EXPOSURE' : 'CUMULATIVE EXPOSURE'}
                      </span>
                      <div className="route-metric-val">
                        {route.estimated_cumulative_exposure.toFixed(1)}
                        <span> µg·min/m³</span>
                      </div>
                    </div>
                  </div>

                  <div className="route-card-tradeoff">
                    <span>Analysis:</span> {route.tradeoff_analysis}
                  </div>

                  <div className="route-card-footer">
                    <span className="route-coverage-tag">
                      Coverage: {route.coverage.coverage_quality} ({route.sampled_points_count} points sampled)
                    </span>
                    <button
                      type="button"
                      className="text-button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedRouteIndex(route.route_index);
                      }}
                    >
                      {isSelected ? 'Currently Selected' : 'View on Map →'}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>

          {/* Interactive Route Map & Profile Section */}
          <div className="citywide-layout" style={{ marginTop: 22 }}>
            {/* Leaflet Map with Route Polylines */}
            <article className="panel citywide-map-panel">
              <div className="panel-heading">
                <div>
                  <h3>Interactive route map</h3>
                  <p>
                    Showing {routeResult.routes.length} driving alternatives and active monitoring stations
                  </p>
                </div>
                <div className="map-legend-items">
                  {routeResult.routes.map((r, i) => (
                    <span
                      key={`leg-${r.route_index}`}
                      className={`map-legend-item ${
                        selectedRouteIndex === r.route_index ? 'active' : ''
                      }`}
                      onClick={() => setSelectedRouteIndex(r.route_index)}
                      style={{ cursor: 'pointer' }}
                    >
                      <i style={{ background: ROUTE_PALETTE[i % ROUTE_PALETTE.length].stroke }} />
                      Route {r.route_index + 1}
                    </span>
                  ))}
                </div>
              </div>

              <div className="citywide-map" style={{ height: 420 }}>
                <MapContainer
                  center={[parseFloat(originLat), parseFloat(originLon)]}
                  zoom={12}
                  scrollWheelZoom
                  zoomControl={false}
                  className="leaflet-map"
                >
                  <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />
                  <ZoomControl position="bottomright" />
                  <MapAutoFit coordinates={allRouteCoords} />

                  {/* Draw All Alternative Routes */}
                  {routeResult.routes.map((route, idx) => {
                    const isSelected = selectedRouteIndex === route.route_index;
                    const palette = ROUTE_PALETTE[idx % ROUTE_PALETTE.length];
                    const polyPositions = (route.geometry?.coordinates || []).map(
                      ([lon, lat]) => [lat, lon]
                    );

                    return (
                      <Polyline
                        key={`poly-${route.route_index}`}
                        positions={polyPositions}
                        pathOptions={{
                          color: palette.stroke,
                          weight: isSelected ? 6 : 3.5,
                          opacity: isSelected ? 0.95 : 0.45,
                          dashArray: isSelected ? undefined : '5, 8',
                        }}
                        eventHandlers={{
                          click: () => setSelectedRouteIndex(route.route_index),
                        }}
                      >
                        <LeafletTooltip sticky>
                          <strong>Route {route.route_index + 1}</strong>
                          <br />
                          {route.summary}
                          <br />
                          {route.duration_min} min · {route.distance_km} km
                          <br />
                          Mean PM₂.₅: {route.estimated_mean_pm25} µg/m³
                        </LeafletTooltip>
                      </Polyline>
                    );
                  })}

                  {/* Origin Marker */}
                  <CircleMarker
                    center={[parseFloat(originLat), parseFloat(originLon)]}
                    radius={9}
                    pathOptions={{
                      color: '#ffffff',
                      weight: 2.5,
                      fillColor: '#67D8B0',
                      fillOpacity: 1,
                    }}
                  >
                    <Popup>
                      <strong>Origin (A)</strong>
                      <br />
                      Lat: {originLat}, Lon: {originLon}
                    </Popup>
                  </CircleMarker>

                  {/* Destination Marker */}
                  <CircleMarker
                    center={[parseFloat(destLat), parseFloat(destLon)]}
                    radius={9}
                    pathOptions={{
                      color: '#ffffff',
                      weight: 2.5,
                      fillColor: '#D7B66D',
                      fillOpacity: 1,
                    }}
                  >
                    <Popup>
                      <strong>Destination (B)</strong>
                      <br />
                      Lat: {destLat}, Lon: {destLon}
                    </Popup>
                  </CircleMarker>

                  {/* Active Monitoring Station Markers */}
                  {(routeResult.monitoring_stations_used || []).map((station) => (
                    <CircleMarker
                      key={`stn-${station.station_id}`}
                      center={[station.latitude, station.longitude]}
                      radius={5}
                      pathOptions={{
                        color: '#91a49a',
                        weight: 1.5,
                        fillColor: '#1a2c22',
                        fillOpacity: 0.85,
                      }}
                    >
                      <Popup>
                        <strong>{station.name}</strong>
                        <br />
                        Station ID: {station.station_id}
                        <br />
                        Active monitor used for IDW interpolation
                      </Popup>
                    </CircleMarker>
                  ))}
                </MapContainer>
              </div>

              <div className="chart-footnote" style={{ marginTop: 12 }}>
                <span>ⓘ</span> Click on any route path on the map or legend item to inspect its
                detailed pollution profile and sample points.
              </div>
            </article>

            {/* Selected Route Pollution Profile Chart */}
            <article className="panel citywide-detail-panel">
              <div className="panel-heading">
                <div>
                  <h3>Exposure along Route {selectedRoute ? selectedRoute.route_index + 1 : ''}</h3>
                  <p>Estimated PM₂.₅ concentration at 500m intervals</p>
                </div>
                <span className="unit-pill">
                  {selectedRoute ? `${selectedRoute.sampled_points_count} SAMPLES` : ''}
                </span>
              </div>

              {selectedRoute && (
                <>
                  <div className="route-profile-chart" style={{ height: 240, marginTop: 14 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart
                        data={selectedRoute.sample_points}
                        margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
                      >
                        <CartesianGrid stroke="#24342F" strokeDasharray="3 5" vertical={false} />
                        <XAxis
                          dataKey="distance_from_origin_km"
                          tick={{ fill: '#7F938B', fontSize: 11 }}
                          tickFormatter={(v) => `${v.toFixed(1)} km`}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis
                          tick={{ fill: '#7F938B', fontSize: 11 }}
                          axisLine={false}
                          tickLine={false}
                          domain={['auto', 'auto']}
                        />
                        <RechartsTooltip
                          labelFormatter={(dist) => `Distance: ${Number(dist).toFixed(2)} km`}
                          formatter={(val, name, item) => [
                            `${Number(val).toFixed(2)} µg/m³ (${item.payload?.data_source || (routeResult?.is_live ? 'Open-Meteo Model' : 'CPCB Station IDW')})`,
                            routeResult?.is_live ? 'Live Estimated PM₂.₅' : 'Historical PM₂.₅',
                          ]}
                          contentStyle={{
                            background: '#14221D',
                            border: '1px solid #31483E',
                            borderRadius: 8,
                            color: '#EAF5EF',
                            fontSize: 12,
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="estimated_pm25"
                          stroke={
                            ROUTE_PALETTE[
                              selectedRoute.route_index % ROUTE_PALETTE.length
                            ].stroke
                          }
                          strokeWidth={2.5}
                          fill={
                            ROUTE_PALETTE[
                              selectedRoute.route_index % ROUTE_PALETTE.length
                            ].stroke
                          }
                          fillOpacity={0.15}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Coverage Details & Uncertainty */}
                  <div className="route-uncertainty-section" style={{ marginTop: 18 }}>
                    <div className="route-stat-box">
                      <div>
                        <span>CLOSEST MONITOR</span>
                        <strong>
                          {selectedRoute.coverage.min_nearest_station_km.toFixed(1)} km
                        </strong>
                      </div>
                      <div>
                        <span>MAX MONITOR DISTANCE</span>
                        <strong>
                          {selectedRoute.coverage.max_nearest_station_km.toFixed(1)} km
                        </strong>
                      </div>
                      <div>
                        <span>COVERAGE QUALITY</span>
                        <strong style={{ textTransform: 'uppercase' }}>
                          {selectedRoute.coverage.coverage_quality}
                        </strong>
                      </div>
                    </div>

                    <div className="route-notes-list">
                      {selectedRoute.coverage.uncertainty_notes.map((note) => (
                        <p key={note.slice(0, 30)}>
                          <span>•</span> {note}
                        </p>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </article>
          </div>

          {/* Scientific Disclaimer Card */}
          <article className="panel model-warning" style={{ marginTop: 22 }}>
            <strong>Historical Air Quality Disclaimer</strong>
            <p style={{ marginTop: 6, lineHeight: 1.6 }}>
              {routeResult.disclaimer}
            </p>
            <p style={{ marginTop: 6, color: '#889e90', fontSize: 11 }}>
              Inverse Distance Weighting (IDW with power=2) estimates air quality between
              fixed monitoring stations. Real-time traffic congestion, street canyons, wind
              shifts, and micro-scale localized sources can influence immediate in-vehicle
              exposure.
            </p>
          </article>
        </>
      )}
    </section>
  );
}
