
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import './App.css';
import CitywideMap from './components/CitywideMap.jsx';
import LiveAqi from './components/LiveAqi.jsx';
import PollutionRoutes from './components/PollutionRoutes.jsx';
import API_BASE_URL from './config/api.js';
import { LOCATION_PRESETS } from './config/locations.js';
import { useIntelligence } from './context/IntelligenceContext.jsx';

const models = [
  { name: 'Persistence baseline', rmse: 4.3719, mae: 2.8081, r2: 0.9337 },
  { name: 'Linear Regression', rmse: 4.6750, mae: 3.2099, r2: 0.9242 },
  { name: 'Random Forest', rmse: 6.5554, mae: 4.4381, r2: 0.8509 },
];

function App() {
  const {
    activePage,
    setActivePage,
    navigateTo,
    location,
    changeLocation,
    liveAqi,
    livePrediction,
    liveLoading,
    liveError,
    isStale,
    lastRefreshedAt,
    refreshLiveIntelligence,
  } = useIntelligence();
  const [showModels, setShowModels] = useState(false);
  const [summary, setSummary] = useState(null);
  const [history, setHistory] = useState([]);
  const [apiError, setApiError] = useState('');
  const [prediction, setPrediction] = useState(null);
  const [predictionError, setPredictionError] = useState('');
  const [predicting, setPredicting] = useState(false);
  const [historyStartDate, setHistoryStartDate] = useState('2025-12-01');
  const [historyEndDate, setHistoryEndDate] = useState('2025-12-31');
  const [historyRows, setHistoryRows] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');

  const [selectedOptimizer, setSelectedOptimizer] = useState('batch');
  const [gradientData, setGradientData] = useState(null);
  const [gradientLoading, setGradientLoading] = useState(false);
  const [gradientError, setGradientError] = useState('');
  const [gradientLogScale, setGradientLogScale] = useState(false);
  const gradientAbortRef = useRef(null);


  const filteredHistory = historyRows.map((item) => ({
    ...item,
    time: item.timestamp
      ? new Date(item.timestamp).toLocaleString('en-GB', {
          timeZone: 'UTC',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }) + ' UTC'
      : '—',
  }));


  async function loadFilteredHistory() {
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const params = new URLSearchParams({ limit: '2000' });
      if (historyStartDate) params.set('start_date', historyStartDate);
      if (historyEndDate) params.set('end_date', historyEndDate);

      const response = await fetch(
        `${API_BASE_URL}/history?${params.toString()}`
      );
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.detail || 'Could not load filtered history.');
      }

      setHistoryRows(result.data);
    } catch (error) {
      setHistoryError(error.message || 'Could not connect to the history API.');
      setHistoryRows([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  function downloadHistoryCsv() {
    if (!historyRows.length) return;

    const columns = ['timestamp_utc', 'pm25_ug_m3', 'pm10_ug_m3'];
    const rows = historyRows.map((item) => [
      item.timestamp,
      item.pm25 == null ? '' : Number(item.pm25).toFixed(2),
      item.pm10 == null ? '' : Number(item.pm10).toFixed(2)
    ]);

    const csv = [columns, ...rows]
      .map((row) => row.map((value) =>
        `"${String(value).replaceAll('"', '""')}"`
      ).join(','))
      .join('\n');

    const url = URL.createObjectURL(
      new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `airaware-history-${historyStartDate || 'start'}-to-${historyEndDate || 'end'}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const loadGradientDescent = useCallback(async (optimizerKey) => {
    const targetOptimizer = optimizerKey || 'batch';

    if (gradientAbortRef.current) {
      gradientAbortRef.current.abort();
    }
    const controller = new AbortController();
    gradientAbortRef.current = controller;

    setGradientLoading(true);
    setGradientError('');
    // Clear stale data so previous optimizer metrics are not shown while loading
    setGradientData(null);

    try {
      const response = await fetch(
        `${API_BASE_URL}/gradient-descent?optimizer=${targetOptimizer}`,
        { signal: controller.signal }
      );
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.detail || `Could not load ${targetOptimizer.toUpperCase()} training history.`);
      }

      if (gradientAbortRef.current === controller) {
        setGradientData(result);
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        return;
      }
      if (gradientAbortRef.current === controller) {
        setGradientError(error.message || 'Could not connect to the gradient descent API.');
      }
    } finally {
      if (gradientAbortRef.current === controller) {
        gradientAbortRef.current = null;
        setGradientLoading(false);
      }
    }
  }, []);

  function handleOptimizerChange(newOptimizer) {
    if (newOptimizer === selectedOptimizer && (gradientData || gradientLoading)) {
      return;
    }
    setSelectedOptimizer(newOptimizer);
    loadGradientDescent(newOptimizer);
  }

  useEffect(() => {
    if (activePage === 'Gradient Descent' && !gradientData && !gradientLoading && !gradientError) {
      queueMicrotask(() => {
        loadGradientDescent(selectedOptimizer);
      });
    }
  }, [activePage, gradientData, gradientLoading, gradientError, selectedOptimizer, loadGradientDescent]);

  useEffect(() => {
    return () => {
      if (gradientAbortRef.current) {
        gradientAbortRef.current.abort();
        gradientAbortRef.current = null;
      }
    };
  }, []);

  async function requestPrediction() {
    setPredicting(true);
    setPredictionError('');
    setPrediction(null);
    try {
      const response = await fetch(`${API_BASE_URL}/predict`);
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.detail || 'Prediction request failed.');
      }
      setPrediction(result);
    } catch (error) {
      setPredictionError(error.message || 'Could not connect to the prediction API.');
    } finally {
      setPredicting(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function loadAirQuality() {
      try {
        const [summaryResponse, historyResponse] = await Promise.all([
          fetch(`${API_BASE_URL}/summary`),
          fetch(`${API_BASE_URL}/history?limit=24`)
        ]);

        if (!summaryResponse.ok || !historyResponse.ok) {
          throw new Error('The AirAware API returned an error.');
        }

        const summaryData = await summaryResponse.json();
        const historyData = await historyResponse.json();

        if (cancelled) return;

        setSummary(summaryData);
        setHistory(historyData.data.map((item) => ({
          time: new Date(item.timestamp).toLocaleString([], {
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
          }),
          pm25: item.pm25,
          pm10: item.pm10
        })));
        setApiError('');
      } catch {
        if (!cancelled) {
          setApiError('Could not load historical data. Check that the API is running on port 8000.');
        }
      }
    }

    loadAirQuality();
    return () => { cancelled = true; };
  }, []);

  const pageSubtitle = useMemo(() => ({
    Overview: 'Understand the air around you.',
    Forecast: 'Explore the next-hour PM₂.₅ forecast.',
    History: 'Explore historical pollution patterns.',
    'Gradient Descent': 'See how the model learns by reducing prediction error.',
    Routes: 'Compare driving routes by estimated historical PM₂.₅ exposure in Bengaluru.',
    Models: 'Compare models on the untouched test set.',
    Map: 'Explore Bengaluru monitoring stations and historical pollution observations.',
  }[activePage]), [activePage]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#overview" onClick={() => setActivePage('Overview')}>
          <span className="brand-mark"><span /></span>
          <span>airaware<span className="brand-period">.</span></span>
        </a>

        <div className="side-label">WORKSPACE</div>
        <nav className="navigation">
          {[
            ['Overview', '◫'],
            ['Forecast', '⌁'],
            ['History', '◷'],
            ['Gradient Descent', '↘'],
            ['Routes', '⇄'],
            ['Models', '⌘'],
            ['Map', '⌖'],
          ].map(([page, symbol]) => (
            <button
              key={page}
              className={`nav-item ${activePage === page ? 'active' : ''}`}
              onClick={() => {
                setActivePage(page);
                if (page === 'History') loadFilteredHistory();
              }}
            >
              <span className="nav-symbol">{symbol}</span>
              {page}
              {page === 'Forecast' && <span className="nav-dot" />}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="location-card" style={{ padding: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span className="location-icon" style={{ fontSize: 13 }}>⌖</span>
              <span className="location-label" style={{ fontSize: 9 }}>ACTIVE FOCUS LOCATION</span>
            </div>
            <select
              value={location.name}
              onChange={(e) => {
                const found = LOCATION_PRESETS.find((p) => p.name === e.target.value);
                if (found) changeLocation(found);
              }}
              style={{
                width: '100%',
                background: '#14201A',
                border: '1px solid #2C4236',
                color: '#EAF5EF',
                padding: '5px 8px',
                borderRadius: 4,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              {LOCATION_PRESETS.map((p) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
            <div style={{ fontSize: 10, color: '#7E938A', marginTop: 4 }}>
              Lat {(location?.latitude ?? location?.lat ?? 12.9716).toFixed(4)}, Lon {(location?.longitude ?? location?.lon ?? 77.5946).toFixed(4)}
            </div>
          </div>
          <div className="data-status">
            <span className="status-dot" />
            Historical dataset loaded
          </div>
          <p className="sidebar-footnote">AIR QUALITY INTELLIGENCE<br />A STUDENT ML PROJECT</p>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">Workspace <span>/</span> {activePage}</div>

          <div className="workflow-lifecycle-bar" role="navigation" aria-label="Product Workflow">
            {[
              { num: '1', name: 'Sense', page: 'Overview' },
              { num: '2', name: 'Understand', page: 'History' },
              { num: '3', name: 'Predict', page: 'Forecast' },
              { num: '4', name: 'Act', page: 'Routes' },
            ].map((step, idx) => {
              const isCurrent = (
                (step.name === 'Sense' && (activePage === 'Overview' || activePage === 'Map')) ||
                (step.name === 'Understand' && (activePage === 'History' || activePage === 'Gradient Descent')) ||
                (step.name === 'Predict' && (activePage === 'Forecast' || activePage === 'Models')) ||
                (step.name === 'Act' && activePage === 'Routes')
              );
              return (
                <div key={step.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {idx > 0 && <span className="workflow-arrow">→</span>}
                  <button
                    type="button"
                    className={`workflow-step ${isCurrent ? 'active' : ''}`}
                    onClick={() => navigateTo(step.page)}
                    title={`Jump to ${step.name} workflow (${step.page})`}
                  >
                    <span className="step-num">{step.num}</span>
                    <span>{step.name}</span>
                  </button>
                </div>
              );
            })}
          </div>

          <div className="topbar-right">
            <div className="topbar-live-status">
              <span
                className={`live-dot-topbar ${liveLoading ? 'syncing' : (isStale || liveError ? 'stale' : '')}`}
                style={isStale || liveError ? { background: '#E5C07B', boxShadow: '0 0 8px rgba(229,192,123,0.6)' } : {}}
              />
              <div className="topbar-live-text">
                <span className="live-val">
                  {liveAqi?.pollutants?.pm2_5?.value != null
                    ? `${Number(liveAqi.pollutants.pm2_5.value).toFixed(1)} µg/m³ · PM₂.₅`
                    : (liveLoading ? 'Syncing…' : 'Ambient Live')}
                </span>
                <span className="live-sub">
                  {lastRefreshedAt ? `Synced ${lastRefreshedAt.toLocaleTimeString()}` : 'Sync pending'}
                  {isStale && ' · STALE'}
                </span>
              </div>
              <button
                type="button"
                className="topbar-refresh-btn"
                onClick={() => refreshLiveIntelligence()}
                disabled={liveLoading}
                title="Synchronize live atmospheric and forecast telemetry"
              >
                {liveLoading ? '⟳ Syncing…' : '⟳ Sync'}
              </button>
            </div>
            <div className="avatar">A</div>
          </div>
        </header>

        {liveError && (
          <section className="notice" style={{ background: 'rgba(224, 108, 117, 0.15)', borderColor: '#E06C75' }}>
            <span className="notice-icon" style={{ color: '#E06C75' }}>!</span>
            <p>
              <strong>Live Synchronization Warning:</strong> {liveError}. Previous successful live readings are preserved.
            </p>
          </section>
        )}

        <section className="page-heading">
          <div>
            <div className="eyebrow"><span className="eyebrow-line" /> AIR QUALITY INTELLIGENCE</div>
            <h1>{activePage === 'Overview' ? <>A clearer view of<br /><span>the air you breathe.</span></> : activePage}</h1>
            <p>{pageSubtitle}{activePage !== 'Map' ? ' Historical observations from the BTM Layout monitoring station.' : ''}</p>
          </div>
          <div className="heading-date">
            <span className="calendar-icon">▦</span>
            <div><span>DATA PERIOD</span><strong>2024 — 2025</strong></div>
          </div>
        </section>

        {apiError && <section className="notice"><span className="notice-icon">!</span><p>{apiError}</p></section>}

        {activePage !== 'Map' && (
          <section className="notice">
            <span className="notice-icon">i</span>
            <p><strong>Historical data</strong> — dashboard readings are loaded from the AirAware API and the project's hourly dataset. This is not a live sensor feed. The forecast card shows a historical-model estimate, not current air quality.</p>
          </section>
        )}

        {activePage === 'Overview' && (
          <>
            <LiveAqi />

            <div className="section-title-row">
              <div><h2>Historical ground station baseline</h2><p>PM₂.₅ concentration · BTM Layout CPCB station observations</p></div>
              <span className="unit-pill">µg/m³</span>
            </div>

            <section className="metrics-grid">
              <article className="metric-card primary-metric">
                <div className="metric-top"><span>PM₂.₅ CONCENTRATION</span><span className="metric-icon">◉</span></div>
                <div className="metric-value">{summary ? summary.pm25_mean.toFixed(1) : "—"} <span>µg/m³</span></div>
                <div className="metric-bottom"><span className="mini-bar" /> Historical dataset mean</div>
              </article>
              <article className="metric-card">
                <div className="metric-top"><span>PM₁₀ CONCENTRATION</span><span className="metric-icon">◌</span></div>
                <div className="metric-value">{history.length && history[history.length - 1].pm10 != null ? history[history.length - 1].pm10.toFixed(1) : "—"} <span>µg/m³</span></div>
                <div className="metric-bottom">Latest available PM₁₀ observation</div>
              </article>
              <article className="metric-card">
                <div className="metric-top"><span>NEXT-HOUR FORECAST</span><span className="metric-icon">↗</span></div>
                <div className="metric-value">{prediction ? prediction.predicted_pm25.toFixed(1) : "—"} <span>µg/m³</span></div>
                <div className="metric-bottom">{prediction ? 'Historical model estimate · not current AQI' : 'Prediction unavailable'}</div>
              </article>
              <article className="metric-card">
                <div className="metric-top"><span>DATA COVERAGE</span><span className="metric-icon">▤</span></div>
                <div className="metric-value">2 <span>years</span></div>
                <div className="metric-bottom">January 2024 – December 2025</div>
              </article>
            </section>

            <section className="content-grid">
              <article className="panel chart-panel">
                <div className="panel-heading">
                  <div><h3>Recent PM₂.₅ readings</h3><p>Actual historical hourly observations</p></div>
                  <span className="chart-period">LAST 24 HOURS</span>
                </div>
                <div className="chart-legend"><span /> PM₂.₅ concentration</div>
                <div className="chart-wrap">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={history} margin={{ top: 12, right: 8, left: -18, bottom: 0 }}>
                      <defs>
                        <linearGradient id="pmFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#67D8B0" stopOpacity={0.25} />
                          <stop offset="95%" stopColor="#67D8B0" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#24342F" strokeDasharray="3 5" vertical={false} />
                      <XAxis dataKey="time" tick={{ fill: '#7F938B', fontSize: 11 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: '#7F938B', fontSize: 11 }} axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={{ background: '#14221D', border: '1px solid #31483E', borderRadius: 10, color: '#EAF5EF' }} />
                      <Area type="monotone" dataKey="pm25" name="PM₂.₅" stroke="#67D8B0" strokeWidth={2.5} fill="url(#pmFill)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <div className="chart-footnote"><span>ⓘ</span> Historical observations only · not live measurements.</div>
              </article>

              <article className="panel insight-panel">
                <div className="panel-heading"><div><h3>Dataset insights</h3><p>Based on the project's exploratory analysis</p></div></div>
                <div className="insight-number">{summary ? summary.pm25_mean.toFixed(2) : "—"} <span>µg/m³</span></div>
                <p className="insight-caption">Mean PM₂.₅ across available hourly observations</p>
                <div className="insight-divider" />
                <div className="insight-row"><span>Median PM₂.₅</span><strong>{summary ? summary.pm25_median.toFixed(2) : "—"} µg/m³</strong></div>
                <div className="insight-row"><span>Maximum observed</span><strong>{summary ? summary.pm25_max.toFixed(2) : "—"} µg/m³</strong></div>
                <div className="insight-row"><span>Hourly records</span><strong>{summary ? summary.records.toLocaleString() : "—"}</strong></div>
                <div className="insight-row"><span>PM₂.₅ valid records</span><strong>{summary ? summary.pm25_valid_records.toLocaleString() : "—"}</strong></div>
                <div className="insight-note">The source has missing readings and an abrupt late-2025 pollution shift. Interpret results cautiously.</div>
              </article>
            </section>

            <div className="section-title-row" style={{ marginTop: 28 }}>
              <div>
                <h2>Intelligence Lifecycle Command Centre</h2>
                <p>Sense → Understand → Predict → Act · Connected environmental workflow</p>
              </div>
              <span className="unit-pill">WORKFLOW HUB</span>
            </div>

            <section className="intelligence-hub-grid">
              <article className="panel intelligence-hub-card">
                <div className="hub-card-header">
                  <span className="hub-card-step">STAGE 1 · SENSE</span>
                  <span className="hub-card-icon">⌖</span>
                </div>
                <h4>Citywide Spatial Sensing</h4>
                <p>
                  13 physical CPCB/KSPCB ground monitoring stations across Bengaluru paired with continuous live ambient Open-Meteo telemetry.
                </p>
                <div className="hub-card-metric">
                  <span>Current Ambient Baseline</span>
                  <strong>
                    {liveAqi?.pollutants?.pm2_5?.value != null
                      ? `${Number(liveAqi.pollutants.pm2_5.value).toFixed(1)} µg/m³ (${liveAqi.aqi?.us_aqi?.category || 'Moderate'})`
                      : (liveLoading ? 'Syncing live telemetry…' : 'Telemetry active')}
                  </strong>
                </div>
                <div className="hub-card-actions">
                  <button type="button" className="intelligence-pill-btn" onClick={() => navigateTo('Map')}>
                    Explore Spatial Map →
                  </button>
                </div>
              </article>

              <article className="panel intelligence-hub-card">
                <div className="hub-card-header">
                  <span className="hub-card-step">STAGE 2 · UNDERSTAND</span>
                  <span className="hub-card-icon">◷</span>
                </div>
                <h4>Historical Ground Baseline</h4>
                <p>
                  Two years of continuous hourly ground observations (2024–2025) establishing longitudinal baseline patterns and distribution trends.
                </p>
                <div className="hub-card-metric">
                  <span>Historical BTM Mean</span>
                  <strong>{summary ? `${summary.pm25_mean.toFixed(2)} µg/m³ (${summary.records.toLocaleString()} hrs)` : '24.12 µg/m³'}</strong>
                </div>
                <div className="hub-card-actions">
                  <button type="button" className="intelligence-pill-btn" onClick={() => navigateTo('History')}>
                    Analyze History →
                  </button>
                  <button type="button" className="intelligence-nav-link" onClick={() => navigateTo('Gradient Descent')}>
                    Learning GD →
                  </button>
                </div>
              </article>

              <article className="panel intelligence-hub-card">
                <div className="hub-card-header">
                  <span className="hub-card-step">STAGE 3 · PREDICT</span>
                  <span className="hub-card-icon">⌁</span>
                </div>
                <h4>Next-Hour ML Forecast</h4>
                <p>
                  Linear Regression model inferring next-hour PM₂.₅ from meteorological dynamics and diurnal traffic/atmospheric features.
                </p>
                <div className="hub-card-metric">
                  <span>Production Prediction</span>
                  <strong>
                    {livePrediction?.predicted_pm25 != null
                      ? `${Number(livePrediction.predicted_pm25).toFixed(1)} µg/m³ (${(livePrediction.delta_pm25 ?? 0) > 0 ? '+' : ''}${Number(livePrediction.delta_pm25 ?? 0).toFixed(1)} µg/m³)`
                      : (liveLoading ? 'Calculating prediction…' : 'Telemetry synced')}
                  </strong>
                </div>
                <div className="hub-card-actions">
                  <button type="button" className="intelligence-pill-btn" onClick={() => navigateTo('Forecast')}>
                    View Live Forecast →
                  </button>
                  <button type="button" className="intelligence-nav-link" onClick={() => navigateTo('Models')}>
                    Model Specs →
                  </button>
                </div>
              </article>

              <article className="panel intelligence-hub-card">
                <div className="hub-card-header">
                  <span className="hub-card-step">STAGE 4 · ACT</span>
                  <span className="hub-card-icon">⇄</span>
                </div>
                <h4>Pollution-Aware Mobility</h4>
                <p>
                  OSRM routing multi-route engine integrating spatial exposure estimation to recommend healthier commuter corridors.
                </p>
                <div className="hub-card-metric">
                  <span>Decision Support</span>
                  <strong>Alternative Routes · Exposure Proxy Score</strong>
                </div>
                <div className="hub-card-actions">
                  <button type="button" className="intelligence-pill-btn" onClick={() => navigateTo('Routes')}>
                    Plan Clean Route →
                  </button>
                </div>
              </article>
            </section>
          </>
        )}


        {activePage === 'History' && (
          <section className="history-view">
            <div className="history-live-marker-banner">
              <div className="marker-header">
                <span className="live-pill"><span /> LIVE BASELINE REFERENCE</span>
                <span style={{ fontSize: 12, color: '#7F938B' }}>
                  Independent Open-Meteo Telemetry · Not inserted into ground table
                </span>
              </div>
              <div className="marker-content">
                <div className="marker-stat">
                  <span className="label">Current Live PM₂.₅</span>
                  <span className="val">
                    {liveAqi?.pollutants?.pm2_5?.value != null
                      ? `${Number(liveAqi.pollutants.pm2_5.value).toFixed(1)} µg/m³`
                      : 'Syncing…'}
                  </span>
                </div>
                <div className="marker-divider" />
                <div className="marker-stat">
                  <span className="label">Historical Dataset Mean</span>
                  <span className="val">{summary ? `${summary.pm25_mean.toFixed(2)} µg/m³` : '24.12 µg/m³'}</span>
                </div>
                <div className="marker-divider" />
                <div className="marker-stat">
                  <span className="label">Longitudinal Ground Records</span>
                  <span className="val">{summary ? `${summary.pm25_valid_records.toLocaleString()} valid / ${summary.records.toLocaleString()} hrs` : '17,544 hrs'}</span>
                </div>
              </div>
              <div className="context-nav-row" style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid rgba(49, 72, 62, 0.4)' }}>
                <span style={{ fontSize: 12, color: '#7F938B' }}>Next intelligence step:</span>
                <button type="button" className="intelligence-nav-link" onClick={() => navigateTo('Forecast')}>
                  Apply Historical Weights to Forecast →
                </button>
                <button type="button" className="intelligence-nav-link" onClick={() => navigateTo('Map')}>
                  View Spatial Distribution on Map →
                </button>
              </div>
            </div>

            <article className="panel history-filters">
              <div className="panel-heading">
                <div><h3>Filter historical data</h3><p>Select a date range for your analysis</p></div>
                <span className="chart-period">UTC DATES</span>
              </div>
              <div className="forecast-fields">
                <label>Start date
                  <input type="date" value={historyStartDate} max={historyEndDate || undefined}
                    onChange={(event) => setHistoryStartDate(event.target.value)} />
                </label>
                <label>End date
                  <input type="date" value={historyEndDate} min={historyStartDate || undefined}
                    onChange={(event) => setHistoryEndDate(event.target.value)} />
                </label>
              </div>
              <div className="history-actions">
                <button className="primary-button" onClick={loadFilteredHistory} disabled={historyLoading}>
                  {historyLoading ? 'Loading readings…' : 'Apply filters'}
                </button>
                <button className="primary-button" onClick={downloadHistoryCsv} disabled={!historyRows.length}>
                  Download CSV
                </button>
              </div>
              {historyError && <div className="model-warning"><strong>Could not load history</strong><p>{historyError}</p></div>}
              {!historyError && <p className="chart-footnote">{historyRows.length.toLocaleString()} records loaded · timestamps in UTC</p>}
            </article>

            <div className="section-title-row">
              <div>
                <h2>Historical readings</h2>
                <p>Hourly PM₂.₅ and PM₁₀ observations · newest records</p>
              </div>
              <span className="unit-pill">µg/m³</span>
            </div>

            <article className="panel chart-panel">
              <div className="panel-heading">
                <div><h3>Pollution trends</h3><p>{filteredHistory.length.toLocaleString()} observations for the selected date range</p></div>
                <span className="chart-period">HISTORICAL</span>
              </div>
              <div className="chart-legend">
                <span /> PM₂.₅ concentration
                <span style={{ marginLeft: 18, background: '#D7B66D' }} /> PM₁₀ concentration
              </div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={filteredHistory} margin={{ top: 12, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid stroke="#24342F" strokeDasharray="3 5" vertical={false} />
                    <XAxis dataKey="time" tick={{ fill: '#7F938B', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: '#7F938B', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ background: '#14221D', border: '1px solid #31483E', borderRadius: 10, color: '#EAF5EF' }} />
                    <Area type="monotone" dataKey="pm25" name="PM₂.₅" stroke="#67D8B0" strokeWidth={2.5} fill="none" connectNulls={false} />
                    <Area type="monotone" dataKey="pm10" name="PM₁₀" stroke="#D7B66D" strokeWidth={2} fill="none" connectNulls={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div className="chart-footnote"><span>ⓘ</span> These are the most recent records in the dataset, ending December 31, 2025.</div>
            </article>

            <article className="panel models-panel" style={{ marginTop: 22 }}>
              <div className="panel-heading">
                <div><h3>Recorded values</h3><p>Timestamped hourly observations</p></div>
                <span className="unit-pill">{filteredHistory.length} records</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>TIMESTAMP</th><th>PM₂.₅ (µg/m³)</th><th>PM₁₀ (µg/m³)</th></tr></thead>
                  <tbody>
                    {[...filteredHistory].reverse().map((item, index) => (
                      <tr key={`${item.time}-${index}`}>
                        <td>{item.time}</td>
                        <td>{item.pm25 == null ? '—' : item.pm25.toFixed(2)}</td>
                        <td>{item.pm10 == null ? '—' : item.pm10.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>

            <div className="context-nav-row" style={{ marginTop: 20 }}>
              <span style={{ fontSize: 13, color: '#7F938B' }}>Continue Workflow:</span>
              <button type="button" className="intelligence-pill-btn" onClick={() => navigateTo('Forecast')}>
                View Next-Hour Prediction →
              </button>
              <button type="button" className="intelligence-pill-btn" onClick={() => navigateTo('Map')}>
                Explore Citywide Station Map →
              </button>
            </div>
          </section>
        )}

        {activePage === 'Forecast' && (
          <section className="forecast-view" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {/* Live Next-Hour ML Prediction Card */}
            <article className="panel placeholder-panel" style={{ textAlign: 'left', alignItems: 'stretch' }}>
              <div className="panel-heading" style={{ flexWrap: 'wrap', gap: 12 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span className="status-dot live" style={{ width: 8, height: 8 }} />
                    <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: '#67D8B0' }}>
                      STAGE 3 · PREDICTION INTELLIGENCE
                    </span>
                    {isStale && (
                      <span className="coord-status-badge coord-status-provisional" style={{ marginLeft: 6 }}>
                        STALE TELEMETRY
                      </span>
                    )}
                  </div>
                  <h3 style={{ fontSize: 18, color: '#EAF5EF', margin: 0 }}>Next-hour live PM₂.₅ inference</h3>
                  <p style={{ margin: '4px 0 0', color: '#7F938B', fontSize: 13 }}>
                    Current atmospheric telemetry at <strong>{location?.name || 'Central Bengaluru'}</strong> ({(location?.latitude ?? location?.lat ?? 12.9716).toFixed(4)}, {(location?.longitude ?? location?.lon ?? 77.5946).toFixed(4)}) fed directly into trained Linear Regression pipeline
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <select
                    value={location.name}
                    onChange={(e) => {
                      const found = LOCATION_PRESETS.find((p) => p.name === e.target.value);
                      if (found) changeLocation(found);
                    }}
                    style={{
                      background: '#14201A',
                      border: '1px solid #2C4236',
                      color: '#67D8B0',
                      padding: '6px 10px',
                      borderRadius: 6,
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                    title="Choose location to compute live forecast"
                  >
                    {LOCATION_PRESETS.map((p) => (
                      <option key={p.name} value={p.name}>{p.name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="intelligence-pill-btn"
                    onClick={() => refreshLiveIntelligence()}
                    disabled={liveLoading}
                    style={{
                      background: 'rgba(103, 216, 176, 0.15)',
                      borderColor: '#67D8B0',
                      color: '#67D8B0',
                    }}
                  >
                    {liveLoading ? 'Calculating…' : '⟳ Refresh Inference'}
                  </button>
                  <span className="unit-pill">ML INFERENCE</span>
                </div>
              </div>

              {livePrediction ? (
                <>
                  <div className="metrics-grid" style={{ marginTop: 16 }}>
                    <div className="metric-card">
                      <div className="metric-top"><span>CURRENT INPUT PM₂.₅</span><span className="metric-icon">◉</span></div>
                      <div className="metric-value">{Number(livePrediction.current_pm25).toFixed(1)} <span>µg/m³</span></div>
                      <div className="metric-bottom">Open-Meteo current baseline</div>
                    </div>

                    <div className="metric-card primary-metric">
                      <div className="metric-top"><span>PREDICTED NEXT-HOUR PM₂.₅</span><span className="metric-icon">↗</span></div>
                      <div className="metric-value">{Number(livePrediction.predicted_pm25).toFixed(1)} <span>µg/m³</span></div>
                      <div className="metric-bottom">
                        Target: {new Date(livePrediction.forecast_timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>

                    <div className="metric-card">
                      <div className="metric-top"><span>PROJECTED DELTA</span><span className="metric-icon">⇄</span></div>
                      <div className="metric-value">
                        {(livePrediction.delta_pm25 ?? 0) > 0 ? '+' : ''}{Number(livePrediction.delta_pm25 ?? 0).toFixed(1)} <span>µg/m³</span>
                      </div>
                      <div className="metric-bottom">
                        {livePrediction.current_pm25 ? `${(((livePrediction.delta_pm25 ?? 0) / livePrediction.current_pm25) * 100).toFixed(1)}% expected change` : 'Next-hour estimate'}
                      </div>
                    </div>

                    <div className="metric-card">
                      <div className="metric-top"><span>PIPELINE ARTIFACT</span><span className="metric-icon">⌘</span></div>
                      <div className="metric-value" style={{ fontSize: 18, paddingTop: 6 }}>
                        {livePrediction.model_name || 'Linear Reg'}
                      </div>
                      <div className="metric-bottom">8 meteorological & temporal features</div>
                    </div>
                  </div>

                  {livePrediction.input_features && (
                    <div style={{ marginTop: 20 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#7F938B', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
                        Active Model Input Features (8)
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
                        <div style={{ background: '#14221D', border: '1px solid #24342F', borderRadius: 8, padding: '8px 12px' }}>
                          <span style={{ fontSize: 11, color: '#7F938B', display: 'block' }}>PM₂.₅ Baseline</span>
                          <strong style={{ fontSize: 14, color: '#EAF5EF' }}>{Number(livePrediction.input_features['PM2.5 (µg/m³)'] ?? 0).toFixed(1)} µg/m³</strong>
                        </div>
                        <div style={{ background: '#14221D', border: '1px solid #24342F', borderRadius: 8, padding: '8px 12px' }}>
                          <span style={{ fontSize: 11, color: '#7F938B', display: 'block' }}>Temperature</span>
                          <strong style={{ fontSize: 14, color: '#EAF5EF' }}>{Number(livePrediction.input_features.temperature_c ?? 0).toFixed(1)} °C</strong>
                        </div>
                        <div style={{ background: '#14221D', border: '1px solid #24342F', borderRadius: 8, padding: '8px 12px' }}>
                          <span style={{ fontSize: 11, color: '#7F938B', display: 'block' }}>Relative Humidity</span>
                          <strong style={{ fontSize: 14, color: '#EAF5EF' }}>{Number(livePrediction.input_features.relative_humidity_pct ?? 0).toFixed(0)} %</strong>
                        </div>
                        <div style={{ background: '#14221D', border: '1px solid #24342F', borderRadius: 8, padding: '8px 12px' }}>
                          <span style={{ fontSize: 11, color: '#7F938B', display: 'block' }}>Precipitation</span>
                          <strong style={{ fontSize: 14, color: '#EAF5EF' }}>{Number(livePrediction.input_features.precipitation_mm ?? 0).toFixed(1)} mm</strong>
                        </div>
                        <div style={{ background: '#14221D', border: '1px solid #24342F', borderRadius: 8, padding: '8px 12px' }}>
                          <span style={{ fontSize: 11, color: '#7F938B', display: 'block' }}>Wind Speed</span>
                          <strong style={{ fontSize: 14, color: '#EAF5EF' }}>{Number(livePrediction.input_features.wind_speed_ms ?? 0).toFixed(2)} m/s</strong>
                        </div>
                        <div style={{ background: '#14221D', border: '1px solid #24342F', borderRadius: 8, padding: '8px 12px' }}>
                          <span style={{ fontSize: 11, color: '#7F938B', display: 'block' }}>Hour of Day</span>
                          <strong style={{ fontSize: 14, color: '#EAF5EF' }}>{livePrediction.input_features.hour}:00</strong>
                        </div>
                        <div style={{ background: '#14221D', border: '1px solid #24342F', borderRadius: 8, padding: '8px 12px' }}>
                          <span style={{ fontSize: 11, color: '#7F938B', display: 'block' }}>Day of Week</span>
                          <strong style={{ fontSize: 14, color: '#EAF5EF' }}>{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][livePrediction.input_features.day_of_week] || livePrediction.input_features.day_of_week}</strong>
                        </div>
                        <div style={{ background: '#14221D', border: '1px solid #24342F', borderRadius: 8, padding: '8px 12px' }}>
                          <span style={{ fontSize: 11, color: '#7F938B', display: 'block' }}>Month</span>
                          <strong style={{ fontSize: 14, color: '#EAF5EF' }}>{['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][livePrediction.input_features.month - 1] || livePrediction.input_features.month}</strong>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="model-warning" style={{ marginTop: 16 }}>
                    <strong>Production Inference Metadata</strong>
                    <p style={{ marginTop: 4 }}>
                      Generated at {new Date(livePrediction.prediction_timestamp || livePrediction.current_timestamp).toLocaleTimeString()}. {livePrediction.disclaimer}
                    </p>
                  </div>

                  <div className="context-nav-row" style={{ marginTop: 14 }}>
                    <span style={{ fontSize: 12, color: '#7F938B' }}>Deep Dive:</span>
                    <button type="button" className="intelligence-pill-btn" onClick={() => navigateTo('Models')}>
                      Inspect Model Architecture & Coefficients →
                    </button>
                    <button type="button" className="intelligence-pill-btn" onClick={() => navigateTo('Routes')}>
                      Plan Route Using Live Forecast →
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ padding: '24px 0', textAlign: 'center', color: '#7F938B' }}>
                  {liveLoading ? 'Calculating live next-hour prediction…' : 'Syncing live prediction telemetry…'}
                </div>
              )}
            </article>

            {/* Historical Observation Benchmark Generator */}
            <article className="panel placeholder-panel">
              <div className="placeholder-icon">⌁</div>
              <h2>Historical Ground-Station Benchmark Generator</h2>
              <p>Generate a test estimate using the saved model against the final recorded observation in the historical dataset.</p>

              <div className="forecast-fields">
                <label>Latest historical PM₂.₅
                  <input type="text" value={prediction ? `${prediction.input_pm25} µg/m³` : 'Loaded from historical data'} readOnly />
                </label>
                <label>Model
                  <input type="text" value="Linear Regression" readOnly />
                </label>
              </div>

              <button className="primary-button" onClick={requestPrediction} disabled={predicting}>
                {predicting ? 'Generating estimate…' : 'Generate historical benchmark estimate'}
              </button>

              {predictionError && <div className="model-warning"><strong>Request failed</strong><p>{predictionError}</p></div>}

              {prediction && (
                <div className="model-warning">
                  <strong>Estimated PM₂.₅: {prediction.predicted_pm25.toFixed(2)} {prediction.unit}</strong>
                  <p>Based on observation: {new Date(prediction.based_on_timestamp).toLocaleString()}</p>
                  <p>Forecast target: {new Date(prediction.forecast_timestamp).toLocaleString()}</p>
                  <p>{prediction.warning}</p>
                </div>
              )}

              <div className="context-nav-row" style={{ marginTop: 16, justifyContent: 'center' }}>
                <button type="button" className="intelligence-nav-link" onClick={() => navigateTo('History')}>
                  ← Review Historical Observations
                </button>
                <button type="button" className="intelligence-nav-link" onClick={() => navigateTo('Gradient Descent')}>
                  Review Model Loss Minimization →
                </button>
              </div>
            </article>
          </section>
        )}

        {activePage === 'Gradient Descent' && (
          <section className="gradient-page" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* Learning Intelligence Connection Banner */}
            <div className="history-live-marker-banner">
              <div className="marker-header">
                <span className="live-pill"><span /> STAGE 2 · LEARNING INTELLIGENCE</span>
                <span style={{ fontSize: 12, color: '#7F938B' }}>
                  Optimization Dynamics · How the prediction model learns
                </span>
              </div>
              <p style={{ margin: '8px 0 0', color: '#B4C5BD', fontSize: 13, lineHeight: 1.55 }}>
                AirAware's next-hour prediction engine is powered by a Linear Regression model fitted by minimizing Mean Squared Error (MSE) loss across historical observations. This interactive environment visualizes how <strong>Batch Gradient Descent</strong> and <strong>Stochastic Gradient Descent (SGD)</strong> converge toward optimal weights.
              </p>
              <div className="context-nav-row" style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid rgba(49, 72, 62, 0.4)' }}>
                <span style={{ fontSize: 12, color: '#7F938B' }}>Connected Intelligence:</span>
                <button type="button" className="intelligence-nav-link" onClick={() => navigateTo('Models')}>
                  Inspect 8-Feature Pipeline & Test Scores →
                </button>
                <button type="button" className="intelligence-nav-link" onClick={() => navigateTo('Forecast')}>
                  See Trained Weights Applied to Live Forecast →
                </button>
              </div>
            </div>

            <div className="metrics-grid gradient-metrics-grid">
              <article className="panel metric-card">
                <span className="metric-label">INITIAL TRAINING MSE</span>
                <div className="metric-value">
                  {gradientData ? gradientData.initial_mse.toFixed(2) : '—'}
                </div>
                <span className="metric-note">
                  {gradientData ? 'At the first recorded checkpoint' : 'Loading…'}
                </span>
              </article>
              <article className="panel metric-card">
                <span className="metric-label">FINAL TRAINING MSE</span>
                <div className="metric-value">
                  {gradientData ? gradientData.final_recorded_mse.toFixed(2) : '—'}
                </div>
                <span className="metric-note">
                  {gradientData
                    ? `At epoch ${gradientData.checkpoints[gradientData.checkpoints.length - 1]?.epoch ?? '—'}`
                    : 'Loading…'}
                </span>
              </article>
              <article className="panel metric-card">
                <span className="metric-label">LOSS REDUCTION</span>
                <div className="metric-value">
                  {gradientData ? `${gradientData.loss_reduction_percent.toFixed(2)}` : '—'}
                  {gradientData && <span>%</span>}
                </div>
                <span className="metric-note">
                  {gradientData ? 'Reduction in recorded training MSE' : 'Loading…'}
                </span>
              </article>
            </div>

            {gradientData?.validation_rmse != null && gradientData?.validation_mae != null && (
              <div>
                <div
                  className="metrics-grid"
                  style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}
                >
                  <article className="panel metric-card">
                    <span className="metric-label">VALIDATION RMSE</span>
                    <div className="metric-value">
                      {gradientData.validation_rmse.toFixed(4)}<span> µg/m³</span>
                    </div>
                    <span className="metric-note">Root mean squared error on validation split</span>
                  </article>
                  <article className="panel metric-card">
                    <span className="metric-label">VALIDATION MAE</span>
                    <div className="metric-value">
                      {gradientData.validation_mae.toFixed(4)}<span> µg/m³</span>
                    </div>
                    <span className="metric-note">Mean absolute error on validation split</span>
                  </article>
                </div>
              </div>
            )}

            <article className="panel chart-panel">
              <div className="panel-heading">
                <div>
                  <h3>Training loss over time</h3>
                  <p>
                    {gradientData
                      ? `Mean squared error across ${gradientData.checkpoints.length} saved checkpoints`
                      : 'Mean squared error at each saved checkpoint'}
                  </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div className="optimizer-segmented-control" role="tablist" aria-label="Select optimizer">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={selectedOptimizer === 'batch'}
                      className={`segmented-btn ${selectedOptimizer === 'batch' ? 'active' : ''}`}
                      onClick={() => handleOptimizerChange('batch')}
                    >
                      Batch Gradient Descent
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={selectedOptimizer === 'sgd'}
                      className={`segmented-btn ${selectedOptimizer === 'sgd' ? 'active' : ''}`}
                      onClick={() => handleOptimizerChange('sgd')}
                    >
                      Stochastic Gradient Descent
                    </button>
                  </div>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => setGradientLogScale((current) => !current)}
                  >
                    {gradientLogScale ? 'Log scale' : 'Linear scale'} · Switch
                  </button>
                </div>
              </div>

              {gradientLoading && (
                <div
                  className="chart-wrap"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 12,
                    color: '#91a49a',
                    fontSize: 13,
                  }}
                >
                  <div className="citywide-loader" />
                  <p style={{ margin: 0 }}>
                    Loading {selectedOptimizer === 'sgd' ? 'Stochastic' : 'Batch'} Gradient Descent data…
                  </p>
                </div>
              )}

              {gradientError && !gradientLoading && (
                <div className="model-warning" style={{ margin: '20px 0' }}>
                  <strong>Could not load training history</strong>
                  <p>{gradientError}</p>
                  <button
                    className="primary-button"
                    type="button"
                    style={{ marginTop: 8 }}
                    onClick={() => loadGradientDescent(selectedOptimizer)}
                  >
                    Retry
                  </button>
                </div>
              )}

              {gradientData && !gradientLoading && (
                <>
                  <div className="chart-legend">
                    <span /> Training MSE · {gradientLogScale ? 'logarithmic scale' : 'linear scale'}
                  </div>
                  <div className="chart-wrap">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart
                        data={gradientData.checkpoints}
                        margin={{ top: 12, right: 8, left: -18, bottom: 0 }}
                      >
                        <CartesianGrid stroke="#24342F" strokeDasharray="3 5" vertical={false} />
                        <XAxis
                          dataKey="epoch"
                          type="number"
                          domain={['dataMin', 'dataMax']}
                          tick={{ fill: '#7F938B', fontSize: 11 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis
                          scale={gradientLogScale ? 'log' : 'auto'}
                          domain={gradientLogScale ? ['auto', 'auto'] : [0, 'auto']}
                          allowDataOverflow={false}
                          tick={{ fill: '#7F938B', fontSize: 11 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <Tooltip
                          labelFormatter={(epoch) => `Epoch ${epoch}`}
                          formatter={(value) => [Number(value).toFixed(4), 'Training MSE']}
                          contentStyle={{
                            background: '#14221D',
                            border: '1px solid #31483E',
                            borderRadius: 10,
                            color: '#EAF5EF',
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="mse"
                          name="Training MSE"
                          stroke="#67D8B0"
                          strokeWidth={2.5}
                          fill="#67D8B0"
                          fillOpacity={0.12}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="chart-footnote">
                    <span>ⓘ</span>
                    {gradientData.optimizer_key === 'sgd'
                      ? `Training loss is checkpointed every ${gradientData.checkpoint_interval} epochs across ${gradientData.training_epochs} epochs. Fluctuations in the loss curve are expected behaviour due to individual sample updates in Stochastic Gradient Descent.`
                      : `Training loss is checkpointed every ${gradientData.checkpoint_interval} epochs across ${gradientData.training_epochs} total epochs. Lower MSE indicates lower average squared prediction error on the training set.`}
                  </div>
                </>
              )}
            </article>

            {gradientData && !gradientLoading && (
              <article className="panel models-panel">
                <div className="panel-heading">
                  <div>
                    <h3>Optimization configuration</h3>
                    <p>Linear Regression trained from scratch</p>
                  </div>
                  <span className="unit-pill">TRAINING DETAILS</span>
                </div>
                <div className="table-wrap">
                  <table>
                    <tbody>
                      <tr>
                        <th>Optimizer</th>
                        <td>{gradientData.optimizer}</td>
                      </tr>
                      <tr>
                        <th>Loss function</th>
                        <td>{gradientData.loss_function}</td>
                      </tr>
                      <tr>
                        <th>Learning rate</th>
                        <td>{gradientData.learning_rate}</td>
                      </tr>
                      <tr>
                        <th>Training epochs</th>
                        <td>{gradientData.training_epochs.toLocaleString()}</td>
                      </tr>
                      <tr>
                        <th>Training rows</th>
                        <td>{gradientData.training_rows.toLocaleString()}</td>
                      </tr>
                      <tr>
                        <th>Checkpoint interval</th>
                        <td>Every {gradientData.checkpoint_interval} epochs</td>
                      </tr>
                      <tr>
                        <th>Loss units</th>
                        <td>{gradientData.unit}</td>
                      </tr>
                      {gradientData.validation_rmse != null && (
                        <tr>
                          <th>Validation RMSE</th>
                          <td>{gradientData.validation_rmse.toFixed(4)} µg/m³</td>
                        </tr>
                      )}
                      {gradientData.validation_mae != null && (
                        <tr>
                          <th>Validation MAE</th>
                          <td>{gradientData.validation_mae.toFixed(4)} µg/m³</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="model-warning" style={{ marginTop: 18 }}>
                  <strong>Understanding the optimizers: Batch GD vs Stochastic GD</strong>
                  <p style={{ marginTop: 8 }}>
                    <strong>Batch Gradient Descent:</strong> Calculates gradients using the entire training dataset ({gradientData.training_rows.toLocaleString()} rows) before updating parameters. Because every parameter update reflects the average error across all samples, it typically produces a smooth, monotonic decrease in training loss.
                  </p>
                  <p style={{ marginTop: 8 }}>
                    <strong>Stochastic Gradient Descent (SGD):</strong> Updates parameters incrementally using individual training samples. Individual sample updates introduce variance into the gradient, producing a noisier training-loss curve. This stochastic behaviour can help the optimizer explore the loss surface.
                  </p>
                  <p style={{ marginTop: 8 }}>
                    <em>Implementation Note:</em> The production live forecast uses the pre-fitted scikit-learn artifact (<code>models/linear_regression.joblib</code>). The optimizer switch above runs our educational from-scratch optimizer to demonstrate learning dynamics.
                  </p>
                </div>

                <div className="context-nav-row" style={{ marginTop: 16 }}>
                  <span style={{ fontSize: 12, color: '#7F938B' }}>Next in Workflow:</span>
                  <button type="button" className="intelligence-pill-btn" onClick={() => navigateTo('Models')}>
                    Explore Test Comparison Table →
                  </button>
                  <button type="button" className="intelligence-pill-btn" onClick={() => navigateTo('Forecast')}>
                    View Live Predictions →
                  </button>
                </div>
              </article>
            )}
          </section>
        )}

        {activePage === 'Routes' && <PollutionRoutes />}

        {activePage === 'Map' && <CitywideMap />}

        {activePage === 'Models' && (
          <section className="models-view" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {/* Deployed Production Pipeline Architecture */}
            <article className="panel models-panel">
              <div className="panel-heading">
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span className="status-dot live" style={{ width: 8, height: 8 }} />
                    <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: '#67D8B0' }}>
                      STAGE 3 · PREDICTION ENGINE
                    </span>
                  </div>
                  <h3>Deployed Linear Regression Pipeline</h3>
                  <p>Artifacts: <code>models/linear_regression.joblib</code> & <code>models/scaler.joblib</code></p>
                </div>
                <span className="unit-pill">PRODUCTION SPEC</span>
              </div>

              <div style={{ marginTop: 14 }}>
                <p style={{ color: '#B4C5BD', fontSize: 13, lineHeight: 1.6, margin: '0 0 14px' }}>
                  The production model uses scikit-learn's <code>StandardScaler</code> transformation followed by an ordinary least-squares <code>LinearRegression</code> regressor. It processes eight engineered temporal and meteorological features in strict chronological order to forecast next-hour PM₂.₅ concentration:
                </p>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
                  <div style={{ background: '#14221D', border: '1px solid #24342F', borderRadius: 8, padding: '10px 14px' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#67D8B0' }}>1. PM2.5 (µg/m³)</div>
                    <p style={{ margin: '4px 0 0', fontSize: 12, color: '#7F938B' }}>
                      Current hourly PM₂.₅ concentration. Strongest linear predictor of next-hour persistence.
                    </p>
                  </div>
                  <div style={{ background: '#14221D', border: '1px solid #24342F', borderRadius: 8, padding: '10px 14px' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#67D8B0' }}>2. temperature_c</div>
                    <p style={{ margin: '4px 0 0', fontSize: 12, color: '#7F938B' }}>
                      Surface ambient temperature in °C. Influences boundary layer height and vertical thermal mixing.
                    </p>
                  </div>
                  <div style={{ background: '#14221D', border: '1px solid #24342F', borderRadius: 8, padding: '10px 14px' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#67D8B0' }}>3. relative_humidity_pct</div>
                    <p style={{ margin: '4px 0 0', fontSize: 12, color: '#7F938B' }}>
                      Relative humidity percentage. Regulates aerosol moisture absorption and particle condensation.
                    </p>
                  </div>
                  <div style={{ background: '#14221D', border: '1px solid #24342F', borderRadius: 8, padding: '10px 14px' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#67D8B0' }}>4. precipitation_mm</div>
                    <p style={{ margin: '4px 0 0', fontSize: 12, color: '#7F938B' }}>
                      Precipitation in mm. Drives wet scavenging wash-out of airborne particulate matter.
                    </p>
                  </div>
                  <div style={{ background: '#14221D', border: '1px solid #24342F', borderRadius: 8, padding: '10px 14px' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#67D8B0' }}>5. wind_speed_ms</div>
                    <p style={{ margin: '4px 0 0', fontSize: 12, color: '#7F938B' }}>
                      Surface wind speed in m/s. Accelerates advection and horizontal atmospheric ventilation.
                    </p>
                  </div>
                  <div style={{ background: '#14221D', border: '1px solid #24342F', borderRadius: 8, padding: '10px 14px' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#67D8B0' }}>6. hour</div>
                    <p style={{ margin: '4px 0 0', fontSize: 12, color: '#7F938B' }}>
                      Hour of day (0–23). Captures cyclical morning and evening urban traffic congestion peaks.
                    </p>
                  </div>
                  <div style={{ background: '#14221D', border: '1px solid #24342F', borderRadius: 8, padding: '10px 14px' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#67D8B0' }}>7. day_of_week</div>
                    <p style={{ margin: '4px 0 0', fontSize: 12, color: '#7F938B' }}>
                      Day of week (0=Mon to 6=Sun). Separates industrial weekday patterns from weekend lulls.
                    </p>
                  </div>
                  <div style={{ background: '#14221D', border: '1px solid #24342F', borderRadius: 8, padding: '10px 14px' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#67D8B0' }}>8. month</div>
                    <p style={{ margin: '4px 0 0', fontSize: 12, color: '#7F938B' }}>
                      Month of year (1–12). Incorporates macro seasonal monsoon, winter inversion, and dry seasons.
                    </p>
                  </div>
                </div>

                <div className="context-nav-row" style={{ marginTop: 16 }}>
                  <span style={{ fontSize: 12, color: '#7F938B' }}>Explore Engine:</span>
                  <button type="button" className="intelligence-pill-btn" onClick={() => navigateTo('Gradient Descent')}>
                    View Optimizer Loss Minimization (Batch vs SGD) →
                  </button>
                  <button type="button" className="intelligence-pill-btn" onClick={() => navigateTo('Forecast')}>
                    Test Live Next-Hour Inference →
                  </button>
                </div>
              </div>
            </article>

            {/* Test-Set Comparison Table */}
            <article className="panel models-panel">
              <div className="panel-heading">
                <div>
                  <h3>Test-set model comparison</h3>
                  <p>Untouched chronological test split · saved evaluation</p>
                </div>
                <span className="unit-pill">REAL RESULTS</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>MODEL</th>
                      <th>RMSE ↓</th>
                      <th>MAE ↓</th>
                      <th>R² ↑</th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.map((model) => (
                      <tr key={model.name}>
                        <td>
                          {model.name}
                          {model.name === 'Persistence baseline' && <span className="best-tag">BEST RMSE</span>}
                        </td>
                        <td>{model.rmse.toFixed(4)}</td>
                        <td>{model.mae.toFixed(4)}</td>
                        <td>{model.r2.toFixed(4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="model-warning">
                <strong>Important finding</strong>
                <p>
                  The persistence baseline outperformed the trained models on the held-out test set. Do not assume a trained model is better simply because its validation score was lower.
                </p>
              </div>
              <button className="text-button" onClick={() => setShowModels(!showModels)}>
                {showModels ? 'Hide metric definitions −' : 'Explain the metrics +'}
              </button>
              {showModels && (
                <div className="metric-definitions">
                  <p><strong>RMSE:</strong> Penalizes larger prediction errors; lower is better.</p>
                  <p><strong>MAE:</strong> Average absolute prediction error in µg/m³; lower is better.</p>
                  <p><strong>R²:</strong> Variance explained relative to a mean-prediction reference; higher is better, but interpret it alongside error metrics and the baseline.</p>
                </div>
              )}
            </article>
          </section>
        )}

        <footer className="footer"><span>airaware<span className="brand-period">.</span> <span className="footer-muted">Environmental intelligence, made understandable.</span></span><span>BUILT WITH DATA · NOT LIVE AQI</span></footer>
      </main>
    </div>
  );
}

export default App;
