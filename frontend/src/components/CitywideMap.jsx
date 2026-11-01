import { useEffect, useMemo, useState } from 'react';
import CitywideHistory from './CitywideHistory.jsx';
import CitywideComparison from './CitywideComparison.jsx';
import {
  CircleMarker,
  MapContainer,
  Popup,
  TileLayer,
  ZoomControl,
} from 'react-leaflet';

const API_BASE = 'http://127.0.0.1:8000/api/citywide-expanded';

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

export default function CitywideMap() {
  const [stations, setStations] = useState([]);
  const [readings, setReadings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedStation, setSelectedStation] = useState(null);

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
          <span className="citywide-kicker">BENGALURU MONITORING NETWORK</span>
          <h2>Air quality across the city.</h2>
          <p>
            Explore the locations of available monitoring stations and inspect
            their latest archived pollutant observations.
          </p>
        </div>
        <span className="citywide-status">
          <span className="status-dot" />
          HISTORICAL DATA
        </span>
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
              <div className="panel-heading">
                <div>
                  <h3>Monitoring station map</h3>
                  <p>Select a marker to inspect its readings</p>
                </div>
                <span className="chart-period">BENGALURU, INDIA</span>
              </div>

              <div className="citywide-map">
                <MapContainer
                  center={[12.9716, 77.5946]}
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

                  {stationData.map((station) => {
                    const isSelected =
                      selectedStation === station.station_id;

                    return (
                      <CircleMarker
                        key={station.station_id}
                        center={[station.latitude, station.longitude]}
                        radius={isSelected ? 11 : 8}
                        pathOptions={{
                          color: '#d8ffeb',
                          weight: 2,
                          fillColor: isSelected ? '#d7b66d' : '#77dfb2',
                          fillOpacity: 0.95,
                        }}
                        eventHandlers={{
                          click: () => setSelectedStation(station.station_id),
                        }}
                      >
                        <Popup>
                          <div className="map-popup">
                            <strong>{station.name}</strong>
                            {station.isProvisional && (
                              <span className="coord-status-badge coord-status-provisional">
                                Provisional coordinates
                              </span>
                            )}
                            <span>
                              PM₂.₅:{' '}
                              {station.readings.pm25?.value == null
                                ? '—'
                                : `${station.readings.pm25.value} ${station.readings.pm25.unit}`}
                            </span>
                            <span>
                              PM₁₀:{' '}
                              {station.readings.pm10?.value == null
                                ? '—'
                                : `${station.readings.pm10.value} ${station.readings.pm10.unit}`}
                            </span>
                            <span>Historical observation · not live</span>
                          </div>
                        </Popup>
                      </CircleMarker>
                    );
                  })}
                </MapContainer>
              </div>

              <div className="citywide-map-legend">
                <span className="legend-station-dot" />
                Monitoring station
                <span className="legend-selected-dot" />
                Selected station
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
