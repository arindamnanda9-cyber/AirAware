import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { CITYWIDE_API_BASE as API_BASE } from '../config/api.js';

const PERIODS = [
  { label: '7D', days: 7 },
  { label: '30D', days: 30 },
  { label: '90D', days: 90 },
  { label: '1Y', days: 365 },
];

// Up to 4 stations can be selected simultaneously
const MAX_SELECTED = 4;

// Distinct colours for up to 4 selected stations
const STATION_COLORS = ['#77dfb2', '#d7b66d', '#83a9ff', '#f08080'];

// Default station IDs to pre-select (BTM, Bapuji, Peenya)
const DEFAULT_SELECTED = ['site_162', 'site_1553', 'site_163'];

function formatDate(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  });
}

function ComparisonChart({ title, dataKey, selectedStations, allStationsHistory }) {
  // Build chart data aligned on date
  const chartData = useMemo(() => {
    // Collect all unique dates across selected stations
    const dateSet = new Set();
    selectedStations.forEach((station) => {
      (allStationsHistory[station.station_id] || []).forEach((item) => {
        dateSet.add(item.date);
      });
    });
    const dates = Array.from(dateSet).sort();

    return dates.map((date) => {
      const point = { date };
      selectedStations.forEach((station) => {
        const record = (allStationsHistory[station.station_id] || []).find(
          (item) => item.date === date
        );
        point[station.station_id] = record?.[dataKey] ?? null;
      });
      return point;
    });
  }, [selectedStations, allStationsHistory, dataKey]);

  if (chartData.length === 0) {
    return (
      <article className="panel citywide-comparison-chart">
        <div className="panel-heading">
          <div>
            <h3>{title}</h3>
            <p>Daily average concentration · µg/m³</p>
          </div>
        </div>
        <div className="history-state">No data available for the selected stations and period.</div>
      </article>
    );
  }

  return (
    <article className="panel citywide-comparison-chart">
      <div className="panel-heading">
        <div>
          <h3>{title}</h3>
          <p>Daily average concentration · µg/m³</p>
        </div>
      </div>

      <div className="comparison-chart-area">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 12, right: 16, left: 0, bottom: 4 }}>
            <CartesianGrid stroke="#26352e" strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              tickFormatter={formatDate}
              tick={{ fill: '#91a49a', fontSize: 11 }}
              axisLine={{ stroke: '#35463d' }}
              tickLine={false}
              minTickGap={28}
            />
            <YAxis
              tick={{ fill: '#91a49a', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={48}
            />
            <Tooltip
              contentStyle={{
                background: '#111a16',
                border: '1px solid #35463d',
                borderRadius: 10,
                color: '#e8f2ec',
              }}
              labelFormatter={(label) => formatDate(label)}
              formatter={(value, name) => [
                value == null ? 'Unavailable' : `${value} µg/m³`,
                selectedStations.find((s) => s.station_id === name)
                  ?.station_name?.split(',')[0] || name,
              ]}
            />
            {selectedStations.map((station, index) => (
              <Line
                key={station.station_id}
                type="monotone"
                dataKey={station.station_id}
                name={station.station_id}
                stroke={STATION_COLORS[index % STATION_COLORS.length]}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="comparison-legend">
        {selectedStations.map((station, index) => (
          <span key={station.station_id}>
            <i style={{ background: STATION_COLORS[index % STATION_COLORS.length] }} />
            {station.station_name?.split(',')[0] || station.station_id}
          </span>
        ))}
      </div>
    </article>
  );
}

export default function CitywideComparison() {
  const [days, setDays] = useState(30);
  const [comparison, setComparison] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set(DEFAULT_SELECTED));

  useEffect(() => {
    const controller = new AbortController();

    async function loadComparison() {
      setLoading(true);
      setError('');

      try {
        const response = await fetch(
          `${API_BASE}/comparison?days=${days}`,
          { signal: controller.signal }
        );

        if (!response.ok) {
          throw new Error('Could not load station comparison.');
        }

        const data = await response.json();
        setComparison(data);

        // Set default selection to first 3 stations if current selection
        // has no overlap with the newly loaded stations
        const availableIds = new Set((data.stations || []).map((s) => s.station_id));
        setSelectedIds((prev) => {
          const overlap = [...prev].filter((id) => availableIds.has(id));
          if (overlap.length > 0) return prev;
          // Fall back to DEFAULT_SELECTED that exist in this dataset
          const defaults = DEFAULT_SELECTED.filter((id) => availableIds.has(id));
          return new Set(defaults.slice(0, 3));
        });
      } catch (err) {
        if (err.name !== 'AbortError') {
          setError(err.message || 'Comparison data unavailable.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    loadComparison();

    return () => controller.abort();
  }, [days]);

  const allStations = useMemo(
    () => comparison?.stations || [],
    [comparison]
  );

  // Build a lookup: station_id → array of history records
  const allStationsHistory = useMemo(() => {
    const map = {};
    allStations.forEach((s) => {
      map[s.station_id] = s.history;
    });
    return map;
  }, [allStations]);

  // Ordered list of selected stations, preserving stable color mapping
  const selectedStations = useMemo(
    () => allStations.filter((s) => selectedIds.has(s.station_id)),
    [allStations, selectedIds]
  );

  function toggleStation(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        if (next.size <= 1) return prev; // keep at least one selected
        next.delete(id);
      } else {
        if (next.size >= MAX_SELECTED) return prev; // cap at MAX_SELECTED
        next.add(id);
      }
      return next;
    });
  }

  return (
    <section className="citywide-comparison-section">
      <div className="citywide-comparison-heading">
        <div>
          <span className="citywide-kicker">CITYWIDE ANALYSIS</span>
          <h2>Compare monitoring stations.</h2>
          <p>
            Explore how daily PM2.5 and PM10 concentrations varied across
            Bengaluru's monitoring locations.
          </p>
        </div>

        <div className="comparison-periods">
          {PERIODS.map((period) => (
            <button
              type="button"
              key={period.days}
              className={days === period.days ? 'active' : ''}
              onClick={() => setDays(period.days)}
            >
              {period.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="panel citywide-loading">
          <div className="citywide-loader" />
          <p>Loading station comparison…</p>
        </div>
      ) : error ? (
        <div className="citywide-error">
          <strong>Comparison unavailable</strong>
          <p>{error}</p>
        </div>
      ) : comparison ? (
        <>
          <div className="comparison-date-note">
            Shared comparison window:{' '}
            <strong>{comparison.start_date}</strong>
            {' — '}
            <strong>{comparison.end_date}</strong>
          </div>

          {/* Station selection interface */}
          <div className="comparison-station-selector">
            <div className="comparison-selector-header">
              <span className="comparison-selector-label">
                Select stations to compare
              </span>
              <span className="comparison-selector-hint">
                {selectedIds.size} / {MAX_SELECTED} selected
              </span>
            </div>
            <div className="comparison-station-chips">
              {allStations.map((station) => {
                const isSelected = selectedIds.has(station.station_id);
                // Find color index based on selected order
                const selectedList = [...selectedIds];
                const colorIndex = selectedList.indexOf(station.station_id);
                const chipColor = isSelected
                  ? STATION_COLORS[colorIndex % STATION_COLORS.length]
                  : undefined;

                return (
                  <button
                    type="button"
                    key={station.station_id}
                    className={`comparison-chip ${isSelected ? 'selected' : ''}`}
                    onClick={() => toggleStation(station.station_id)}
                    disabled={!isSelected && selectedIds.size >= MAX_SELECTED}
                    style={isSelected ? { borderColor: chipColor, color: chipColor } : undefined}
                    title={
                      !isSelected && selectedIds.size >= MAX_SELECTED
                        ? `Deselect a station to add ${station.station_name?.split(',')[0]}`
                        : station.station_name
                    }
                  >
                    {isSelected && (
                      <i
                        className="chip-dot"
                        style={{ background: chipColor }}
                      />
                    )}
                    {station.station_name?.split(',')[0] || station.station_id}
                  </button>
                );
              })}
            </div>
          </div>

          {selectedStations.length === 0 ? (
            <div className="history-state">
              Select at least one station to display comparison charts.
            </div>
          ) : (
            <>
              <div className="citywide-comparison-grid">
                <ComparisonChart
                  title="PM2.5 comparison"
                  dataKey="pm25"
                  selectedStations={selectedStations}
                  allStationsHistory={allStationsHistory}
                />
                <ComparisonChart
                  title="PM10 comparison"
                  dataKey="pm10"
                  selectedStations={selectedStations}
                  allStationsHistory={allStationsHistory}
                />
              </div>

              <p className="comparison-footnote">
                Historical daily averages, not live readings. Missing observations
                remain unavailable and are displayed as gaps. City Railway Station
                and Sanegurava Halli have no PM₂.₅ records in this dataset.
              </p>
            </>
          )}
        </>
      ) : null}
    </section>
  );
}
