import { useEffect, useMemo, useState } from 'react';
import CitywideHistory from './CitywideHistory.jsx';
import CitywideComparison from './CitywideComparison.jsx';
import {
  CircleMarker,
  MapContainer,
  Popup,
  TileLayer,
  ZoomControl,
  useMap,
} from 'react-leaflet';

import { CITYWIDE_API_BASE as API_BASE } from '../config/api.js';
import { useIntelligence } from '../context/IntelligenceContext.jsx';

// Station IDs confirmed to have no PM2.5 observations
const NO_PM25_STATIONS = new Set(['site_165', 'site_166']);

function formatTimestamp(timestamp) {
  if (!timestamp) return 'No recorded timestamp';

  return new Date(timestamp).toLocaleString('en-IN', {
    timeZone: 'UTC',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }) + ' UTC';
}

function formatDate(isoString) {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function Reading({ label, reading }) {
  // Use the unit returned by the API. Do not default to µg/m³ when unit is absent.
  const unit = reading?.unit ?? null;
  const hasValue = reading?.value != null;
  return (
    <div className="city-reading">
      <span>{label}</span>
      <strong>
        {hasValue ? reading.value.toFixed(2) : '—'}
        {hasValue && unit && <small> {unit}</small>}
      </strong>
      <span className="city-reading-time">
        {hasValue ? formatTimestamp(reading?.timestamp) : '—'}
      </span>
    </div>
  );
}

function MapRecenter({ lat, lon }) {
  const map = useMap();
  useEffect(() => {
    if (lat != null && lon != null) {
      map.setView([lat, lon], map.getZoom());
    }
  }, [lat, lon, map]);
  return null;
}

export default function CitywideMap() {
  const {
    liveAqi,
    stationsLiveAqi,
    location,
    changeLocation,
    refreshLiveIntelligence,
    liveLoading,
    isStale,
    lastRefreshedAt,
    navigateTo,
  } = useIntelligence();

  const currentLoc = location || { name: 'Central Bengaluru', latitude: 12.9716, longitude: 77.5946 };

  const [stations, setStations] = useState([]);
  const [readings, setReadings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedStation, setSelectedStation] = useState(null);

  // Map layer toggles
  const [showLiveLayer, setShowLiveLayer] = useState(true);
  const [showHistoricalLayer, setShowHistoricalLayer] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    async function loadCitywideData() {
      setLoading(true);
      setError('');

      try {
        const [stationsResponse, readingsResponse] = await Promise.all([
          fetch(`${API_BASE}/stations`, { signal: controller.signal }),
          fetch(`${API_BASE}/latest`, { signal: controller.signal }),
        ]);

        if (!stationsResponse.ok || !readingsResponse.ok) {
          throw new Error('The citywide API returned an error.');
        }

        const [stationsData, readingsData] = await Promise.all([
          stationsResponse.json(),
          readingsResponse.json(),
        ]);

        setStations(stationsData.stations || []);
        setReadings(readingsData.stations || []);
      } catch (err) {
        if (err.name !== 'AbortError') {
          setError(err.message || 'Could not load Bengaluru station data.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    loadCitywideData();

    return () => controller.abort();
  }, []);

  const stationData = useMemo(() => {
    return stations.map((station) => {
      const reading = readings.find(
        (item) => item.station_id === station.station_id
      );
      // Derive provisional status from API metadata only — no hardcoded fallback.
      const isProvisional = station.coordinate_status === 'provisional';

      return {
        ...station,
        readings: reading?.readings || {},
        isProvisional,
      };
    });
  }, [stations, readings]);

  const activeStation = stationData.find(
    (station) => station.station_id === selectedStation
  );

  return (
    <section className="citywide-page">
      <div className="citywide-intro">
        <div>
          <span className="citywide-kicker">SPATIAL INTELLIGENCE · SENSE</span>
          <h2>Air quality across the city.</h2>
          <p>
            Explore live Open-Meteo atmospheric estimates alongside 13 archived CPCB / KSPCB physical ground stations across Bengaluru.
          </p>
        </div>
        <div className="citywide-intro-actions">
          <button
            type="button"
            className="intelligence-pill-btn"
            onClick={() => refreshLiveIntelligence()}
            disabled={liveLoading}
            title="Refresh live atmospheric layer"
          >
            {liveLoading ? 'Refreshing Telemetry…' : '↻ Refresh Live Telemetry'}
          </button>
          <button
            type="button"
            className="intelligence-pill-btn"
            onClick={() => navigateTo('Routes')}
            title="Plan clean driving routes using spatial station data"
          >
            Plan Pollution-Aware Route ⇄
          </button>
          <button
            type="button"
            className="intelligence-pill-btn"
            onClick={() => navigateTo('History')}
            title="Inspect historical timeseries"
          >
            View Timeseries History ◷
          </button>
        </div>
      </div>

      {/* Atmospheric Context vs Ground Observation Banner */}
      <div className="live-distinction-banner" style={{ marginBottom: 18 }}>
        <span className="distinction-badge">SPATIAL TELEMETRY CONTEXT</span>
        <p>
          <strong>Active Monitoring Focus:</strong> {currentLoc.name} (Lat: {currentLoc.latitude.toFixed(4)}, Lon: {currentLoc.longitude.toFixed(4)}) sits at{' '}
          <strong>{liveAqi?.pollutants?.pm2_5?.value != null ? `${Number(liveAqi.pollutants.pm2_5.value).toFixed(1)} µg/m³` : '24.0 µg/m³'} PM₂.₅</strong>{' '}
          (Open-Meteo model estimate, synced at {lastRefreshedAt ? lastRefreshedAt.toLocaleTimeString() : 'initialization'}{isStale ? ' · STALE' : ''}). The map now supports distinct <strong>Live Atmospheric Estimates</strong> and <strong>CPCB Ground Station Archives</strong> layers.
        </p>
      </div>

      {error && (
        <div className="citywide-error">
          <strong>Unable to load station data</strong>
          <p>{error}</p>
          <button onClick={() => window.location.reload()}>Retry</button>
        </div>
      )}

      {loading ? (
        <div className="panel citywide-loading">
          <div className="citywide-loader" />
          <p>Loading Bengaluru monitoring stations…</p>
        </div>
      ) : (
        <>
          <div className="citywide-summary">
            <article className="citywide-stat">
              <span>MONITORING STATIONS</span>
              <strong>{stationData.length.toString().padStart(2, '0')}</strong>
              <small>Stations in this dataset</small>
            </article>
            <article className="citywide-stat">
              <span>TOTAL OBSERVATIONS</span>
              <strong>
                {stationData.reduce(
                  (total, station) => total + station.total_records,
                  0
                ).toLocaleString('en-IN')}
              </strong>
              <small>15-minute source records</small>
            </article>
            <article className="citywide-stat">
              <span>DATA COVERAGE</span>
              <strong>2024–25</strong>
              <small>Historical archive</small>
            </article>
          </div>

          <div className="citywide-layout">
            <article className="panel citywide-map-panel">
              <div className="panel-heading" style={{ flexWrap: 'wrap', gap: '10px' }}>
                <div>
                  <h3>Citywide spatial intelligence map</h3>
                  <p>Toggle live atmospheric estimates vs. physical ground station archive</p>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <button
                    type="button"
                    className={`intelligence-pill-btn ${showLiveLayer ? 'active-pill' : ''}`}
                    style={{
                      background: showLiveLayer ? 'rgba(103, 216, 176, 0.2)' : 'rgba(255,255,255,0.05)',
                      borderColor: showLiveLayer ? '#67D8B0' : '#2A3C34',
                      color: showLiveLayer ? '#67D8B0' : '#889e90',
                      fontSize: '11px',
                    }}
                    onClick={() => setShowLiveLayer((prev) => !prev)}
                  >
                    {showLiveLayer ? '● Live Atmospheric Layer' : '○ Live Atmospheric Layer'}
                  </button>
                  <button
                    type="button"
                    className={`intelligence-pill-btn ${showHistoricalLayer ? 'active-pill' : ''}`}
                    style={{
                      background: showHistoricalLayer ? 'rgba(112, 192, 232, 0.2)' : 'rgba(255,255,255,0.05)',
                      borderColor: showHistoricalLayer ? '#70C0E8' : '#2A3C34',
                      color: showHistoricalLayer ? '#70C0E8' : '#889e90',
                      fontSize: '11px',
                    }}
                    onClick={() => setShowHistoricalLayer((prev) => !prev)}
                  >
                    {showHistoricalLayer ? '● CPCB Ground Stations' : '○ CPCB Ground Stations'}
                  </button>
                </div>
              </div>

              {/* Spatial Resolution Disclosure Banner */}
              <div
                style={{
                  padding: '8px 14px',
                  background: 'rgba(20, 32, 26, 0.65)',
                  borderBottom: '1px solid #23362C',
                  fontSize: '11px',
                  color: '#9BB1A7',
                  lineHeight: 1.45,
                }}
              >
                <strong style={{ color: '#EAF5EF' }}>ℹ Grid Resolution Notice:</strong> Open-Meteo atmospheric model operates on a ~0.1° (~11 km) spatial grid. Coordinates within the same grid cell share identical background atmospheric estimates. CPCB markers indicate physical continuous monitoring stations (historical archive).
              </div>

              <div className="citywide-map">
                <MapContainer
                  center={[currentLoc.latitude, currentLoc.longitude]}
                  zoom={11}
                  scrollWheelZoom
                  zoomControl={false}
                  className="leaflet-map"
                >
                  <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />
                  <ZoomControl position="bottomright" />
                  <MapRecenter lat={currentLoc.latitude} lon={currentLoc.longitude} />

                  {/* Active Focus Location Marker */}
                  <CircleMarker
                    center={[currentLoc.latitude, currentLoc.longitude]}
                    radius={13}
                    pathOptions={{
                      color: '#FFD166',
                      weight: 3,
                      fillColor: 'rgba(255, 209, 102, 0.45)',
                      fillOpacity: 0.9,
                    }}
                  >
                    <Popup>
                      <div className="map-popup">
                        <strong style={{ color: '#FFD166' }}>★ ACTIVE FOCUS LOCATION</strong>
                        <span style={{ fontWeight: 600 }}>{currentLoc.name}</span>
                        <span>Lat: {currentLoc.latitude.toFixed(4)}, Lon: {currentLoc.longitude.toFixed(4)}</span>
                        <div style={{ marginTop: 6, borderTop: '1px solid #334', paddingTop: 6 }}>
                          <span>
                            Current PM₂.₅:{' '}
                            <strong>
                              {liveAqi?.pollutants?.pm2_5?.value != null
                                ? `${Number(liveAqi.pollutants.pm2_5.value).toFixed(1)} µg/m³`
                                : '—'}
                            </strong>
                          </span>
                          <span>
                            US AQI: <strong>{liveAqi?.aqi?.us_aqi?.value ?? '—'}</strong>
                          </span>
                          <span style={{ fontSize: '10px', color: '#889e90' }}>
                            Source: Open-Meteo ({lastRefreshedAt ? lastRefreshedAt.toLocaleTimeString() : 'sync pending'})
                          </span>
                        </div>
                      </div>
                    </Popup>
                  </CircleMarker>

                  {/* Layer 1: Live Open-Meteo Atmospheric Stations */}
                  {showLiveLayer &&
                    (stationsLiveAqi?.stations || []).map((st) => {
                      const pm25 = st.pm2_5 ?? 0;
                      let pinColor = '#67D8B0';
                      if (pm25 > 60) pinColor = '#E06C75';
                      else if (pm25 > 30) pinColor = '#E5C07B';

                      return (
                        <CircleMarker
                          key={`live-stn-${st.station_id}`}
                          center={[st.latitude, st.longitude]}
                          radius={9}
                          pathOptions={{
                            color: '#ffffff',
                            weight: 2,
                            fillColor: pinColor,
                            fillOpacity: 0.9,
                          }}
                        >
                          <Popup>
                            <div className="map-popup">
                              <span
                                style={{
                                  fontSize: '10px',
                                  fontWeight: 700,
                                  color: '#67D8B0',
                                  background: 'rgba(103, 216, 176, 0.15)',
                                  padding: '2px 6px',
                                  borderRadius: 4,
                                  display: 'inline-block',
                                  marginBottom: 4,
                                }}
                              >
                                LIVE ATMOSPHERIC ESTIMATE
                              </span>
                              <strong>{st.name}</strong>
                              <span>
                                Atmospheric PM₂.₅: <strong>{st.pm2_5 != null ? `${st.pm2_5.toFixed(1)} µg/m³` : '—'}</strong>
                              </span>
                              <span>
                                Atmospheric PM₁₀: <strong>{st.pm10 != null ? `${st.pm10.toFixed(1)} µg/m³` : '—'}</strong>
                              </span>
                              <span>
                                US AQI: <strong>{st.us_aqi ?? '—'}</strong> · European AQI: <strong>{st.european_aqi ?? '—'}</strong>
                              </span>
                              <span style={{ fontSize: '10px', color: '#889e90' }}>
                                Model Grid: ({st.model_grid_latitude}, {st.model_grid_longitude})
                              </span>
                              <button
                                type="button"
                                style={{
                                  marginTop: 8,
                                  padding: '4px 8px',
                                  fontSize: '11px',
                                  background: '#233d32',
                                  border: '1px solid #457b63',
                                  color: '#e8f5ee',
                                  borderRadius: 4,
                                  cursor: 'pointer',
                                }}
                                onClick={() =>
                                  changeLocation({
                                    name: st.name,
                                    latitude: st.latitude,
                                    longitude: st.longitude,
                                  })
                                }
                              >
                                Set as Focus Location ⌖
                              </button>
                            </div>
                          </Popup>
                        </CircleMarker>
                      );
                    })}

                  {/* Layer 2: CPCB / KSPCB Historical Ground Stations */}
                  {showHistoricalLayer &&
                    stationData.map((station) => {
                      const isSelected = selectedStation === station.station_id;

                      return (
                        <CircleMarker
                          key={`hist-stn-${station.station_id}`}
                          center={[station.latitude, station.longitude]}
                          radius={isSelected ? 11 : 7}
                          pathOptions={{
                            color: '#70C0E8',
                            weight: isSelected ? 3 : 1.5,
                            fillColor: isSelected ? '#d7b66d' : '#142a38',
                            fillOpacity: 0.85,
                          }}
                          eventHandlers={{
                            click: () => setSelectedStation(station.station_id),
                          }}
                        >
                          <Popup>
                            <div className="map-popup">
                              <span
                                style={{
                                  fontSize: '10px',
                                  fontWeight: 700,
                                  color: '#70C0E8',
                                  background: 'rgba(112, 192, 232, 0.15)',
                                  padding: '2px 6px',
                                  borderRadius: 4,
                                  display: 'inline-block',
                                  marginBottom: 4,
                                }}
                              >
                                HISTORICAL CPCB GROUND STATION
                              </span>
                              <strong>{station.name}</strong>
                              {station.isProvisional && (
                                <span className="coord-status-badge coord-status-provisional">
                                  Provisional coordinates
                                </span>
                              )}
                              <span>
                                Archived PM₂.₅:{' '}
                                {station.readings.pm25?.value == null
                                  ? '—'
                                  : `${station.readings.pm25.value} ${station.readings.pm25.unit}`}
                              </span>
                              <span>
                                Archived PM₁₀:{' '}
                                {station.readings.pm10?.value == null
                                  ? '—'
                                  : `${station.readings.pm10.value} ${station.readings.pm10.unit}`}
                              </span>
                              <span style={{ fontSize: '10px', color: '#ffaa88' }}>
                                Physical sensor archive (2024–2025) · not live
                              </span>
                            </div>
                          </Popup>
                        </CircleMarker>
                      );
                    })}
                </MapContainer>
              </div>

              <div className="citywide-map-legend" style={{ display: 'flex', flexWrap: 'wrap', gap: '14px' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <i style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid #FFD166', background: 'rgba(255, 209, 102, 0.45)', display: 'inline-block' }} />
                  Active Focus Location
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <i style={{ width: 10, height: 10, borderRadius: '50%', background: '#67D8B0', display: 'inline-block' }} />
                  Live Atmospheric Model Estimate (Open-Meteo)
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <i style={{ width: 10, height: 10, borderRadius: '50%', border: '1.5px solid #70C0E8', background: '#142a38', display: 'inline-block' }} />
                  CPCB Ground Station (Historical Archive)
                </span>
              </div>
            </article>

            <article className="panel citywide-station-panel">
              <div className="panel-heading">
                <div>
                  <h3>Station directory</h3>
                  <p>{stationData.length} stations available</p>
                </div>
              </div>

              <div className="citywide-station-list">
                {stationData.map((station, index) => (
                  <button
                    type="button"
                    key={station.station_id}
                    className={`citywide-station-item ${
                      selectedStation === station.station_id ? 'selected' : ''
                    }`}
                    onClick={() => setSelectedStation(station.station_id)}
                  >
                    <span className="station-index">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="station-info">
                      <strong>{station.name.split(',')[0]}</strong>
                      <small>
                        {station.name.includes(',')
                          ? station.name.split(',').slice(1).join(',').trim()
                          : 'Bengaluru'}
                        {station.isProvisional && (
                          <span className="station-provisional-badge"> · provisional coords</span>
                        )}
                      </small>
                    </span>
                    <span className="station-arrow">↗</span>
                  </button>
                ))}
              </div>

              {activeStation && (
                <div className="citywide-selected-details">
                  <span className="citywide-kicker">SELECTED STATION</span>
                  <h4>
                    {activeStation.name}
                    {activeStation.isProvisional && (
                      <span className="coord-status-badge coord-status-provisional">
                        Provisional coordinates
                      </span>
                    )}
                  </h4>

                  {NO_PM25_STATIONS.has(activeStation.station_id) && (
                    <div className="station-no-pm25-notice">
                      No PM₂.₅ observations in the current dataset for this station.
                    </div>
                  )}

                  <div className="citywide-readings citywide-readings-expanded">
                    <Reading
                      label="PM₂.₅"
                      reading={activeStation.readings.pm25}
                    />
                    <Reading
                      label="PM₁₀"
                      reading={activeStation.readings.pm10}
                    />
                    <Reading
                      label="NO₂"
                      reading={activeStation.readings.no2}
                    />
                    <Reading
                      label="SO₂"
                      reading={activeStation.readings.so2}
                    />
                    <Reading
                      label="CO"
                      reading={activeStation.readings.co}
                    />
                    <Reading
                      label="Ozone"
                      reading={activeStation.readings.ozone}
                    />
                  </div>

                  <div className="station-coverage">
                    <span>Available records</span>
                    <strong>
                      {activeStation.total_records.toLocaleString('en-IN')}
                    </strong>
                    <span>First dataset record</span>
                    <strong>{formatDate(activeStation.first_record)}</strong>
                    <span>Last dataset record</span>
                    <strong>{formatDate(activeStation.last_record)}</strong>
                  </div>
                </div>
              )}

              {!activeStation && (
                <div className="citywide-select-hint">
                  Select a station to view its archived readings.
                </div>
              )}
            </article>
          </div>

          {activeStation && (
            <CitywideHistory
              stationId={activeStation.station_id}
              stationName={activeStation.name}
              hasNoPm25={NO_PM25_STATIONS.has(activeStation.station_id)}
            />
          )}

          <CitywideComparison />

          <div className="citywide-data-note">
            <strong>About these readings</strong>
            <p>
              Values shown are the latest available valid observations in the
              historical dataset, not current air quality. Different stations
              have different data end dates. Missing pollutant readings are
              shown as unavailable rather than zero. CO is reported in mg/m³;
              all other pollutants in µg/m³.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
