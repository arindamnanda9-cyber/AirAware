import { useEffect, useState } from 'react';
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

function formatDate(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  });
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;

  return (
    <div className="history-tooltip">
      <strong>{formatDate(label)}</strong>
      {payload.map((item) => (
        <div key={item.dataKey}>
          <span style={{ background: item.color }} />
          {item.name}:{' '}
          {item.value == null ? 'Unavailable' : `${item.value} µg/m³`}
        </div>
      ))}
    </div>
  );
}

export default function CitywideHistory({ stationId, stationName, hasNoPm25 }) {
  const [days, setDays] = useState(30);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!stationId) return undefined;

    const controller = new AbortController();

    async function loadHistory() {
      setLoading(true);
      setError('');
      setHistory([]);

      try {
        const response = await fetch(
          `${API_BASE}/history/${stationId}?days=${days}`,
          { signal: controller.signal },
        );

        if (!response.ok) {
          throw new Error('Unable to load historical pollution data.');
        }

        const data = await response.json();
        setHistory(data.history || []);
      } catch (err) {
        if (err.name !== 'AbortError') {
          setError(err.message || 'Something went wrong.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    loadHistory();

    return () => controller.abort();
  }, [stationId, days]);

  if (!stationId) return null;

  // Determine if the loaded data has any non-null pm25 values
  const hasPm25Data = history.some((item) => item.pm25 != null);

  return (
    <section className="panel citywide-history-panel">
      <div className="panel-heading">
        <div>
          <h3>Historical pollution trends</h3>
          <p>{stationName} · Daily average observations</p>
        </div>

        <div className="history-periods">
          {PERIODS.map((period) => (
            <button
              key={period.days}
              type="button"
              className={days === period.days ? 'active' : ''}
              onClick={() => setDays(period.days)}
              disabled={loading}
            >
              {period.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="history-state">Loading historical observations…</div>
      ) : error ? (
        <div className="history-state history-error">{error}</div>
      ) : history.length === 0 ? (
        <div className="history-state">
          No historical observations available for this period.
        </div>
      ) : hasNoPm25 || !hasPm25Data ? (
        <>
          <div className="history-state">
            <span>
              PM₂.₅ observations are unavailable for this station.
              {history.length > 0 && hasPm25Data === false && (
                <> PM₁₀ data may still be available in the chart below.</>
              )}
            </span>
          </div>
          {/* Still render PM10 if available */}
          {history.some((item) => item.pm10 != null) && (
            <>
              <div className="history-legend">
                <span><i className="history-pm10" /> PM10</span>
              </div>
              <div className="history-chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={history}
                    margin={{ top: 12, right: 12, left: 0, bottom: 4 }}
                  >
                    <CartesianGrid
                      stroke="#26372e"
                      strokeDasharray="3 3"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="date"
                      tickFormatter={formatDate}
                      stroke="#81948a"
                      tick={{ fill: '#91a398', fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={25}
                    />
                    <YAxis
                      stroke="#81948a"
                      tick={{ fill: '#91a398', fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      width={48}
                      domain={['auto', 'auto']}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Line
                      type="monotone"
                      dataKey="pm10"
                      name="PM10"
                      stroke="#d7b66d"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                      connectNulls={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="history-footnote">
                Daily PM₁₀ averages only · PM₂.₅ unavailable for this station.
                Missing readings are not treated as zero. Historical data only.
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <div className="history-legend">
            <span><i className="history-pm25" /> PM2.5</span>
            <span><i className="history-pm10" /> PM10</span>
          </div>

          <div className="history-chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={history}
                margin={{ top: 12, right: 12, left: 0, bottom: 4 }}
              >
                <CartesianGrid
                  stroke="#26372e"
                  strokeDasharray="3 3"
                  vertical={false}
                />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDate}
                  stroke="#81948a"
                  tick={{ fill: '#91a398', fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={25}
                />
                <YAxis
                  stroke="#81948a"
                  tick={{ fill: '#91a398', fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                  domain={['auto', 'auto']}
                />
                <Tooltip content={<CustomTooltip />} />
                <Line
                  type="monotone"
                  dataKey="pm25"
                  name="PM2.5"
                  stroke="#77dfb2"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  connectNulls={false}
                />
                <Line
                  type="monotone"
                  dataKey="pm10"
                  name="PM10"
                  stroke="#d7b66d"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="history-footnote">
            Daily averages calculated from available 15-minute observations.
            Missing readings are not treated as zero. Historical data only.
          </div>
        </>
      )}
    </section>
  );
}
