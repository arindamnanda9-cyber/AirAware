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

const API_BASE = 'http://127.0.0.1:8000/api/citywide';

const PERIODS = [
  { label: '7D', days: 7 },
  { label: '30D', days: 30 },
  { label: '90D', days: 90 },
  { label: '1Y', days: 365 },
];

const STATION_COLORS = ['#77dfb2', '#d7b66d', '#83a9ff'];

function formatDate(date) {
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
  });
}

function ComparisonChart({ title, dataKey, stations, history }) {
  const chartData = history.map((record) => {
    const point = {
      date: formatDate(record.date),
      fullDate: record.date,
    };

    stations.forEach((station) => {
      const stationRecord = station.history.find(
        (item) => item.date === record.date
      );
      point[station.station_id] = stationRecord?.[dataKey] ?? null;
    });

    return point;
  });

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
              labelFormatter={(_, payload) =>
                payload?.[0]?.payload?.fullDate || ''
              }
              formatter={(value, name) => [
                value == null ? 'Unavailable' : `${value} µg/m³`,
                stations.find((station) => station.station_id === name)
                  ?.station_name || name,
              ]}
            />
            {stations.map((station, index) => (
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
        {stations.map((station, index) => (
          <span key={station.station_id}>
            <i style={{ background: STATION_COLORS[index % STATION_COLORS.length] }} />
            {station.station_name.split(',')[0]}
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

  const stations = comparison?.stations || [];

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
            Shared comparison window: <strong>{comparison.start_date}</strong>
            {' — '}
            <strong>{comparison.end_date}</strong>
          </div>

          <div className="citywide-comparison-grid">
            <ComparisonChart
              title="PM2.5 comparison"
              dataKey="pm25"
              stations={stations}
              history={stations[0]?.history || []}
            />
            <ComparisonChart
              title="PM10 comparison"
              dataKey="pm10"
              stations={stations}
              history={stations[0]?.history || []}
            />
          </div>

          <p className="comparison-footnote">
            Historical daily averages, not live readings. Missing observations
            remain unavailable and are displayed as gaps.
          </p>
        </>
      ) : null}
    </section>
  );
}
