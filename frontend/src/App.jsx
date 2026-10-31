
import { useEffect, useMemo, useState } from 'react';
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

const models = [
  { name: 'Persistence baseline', rmse: 4.3719, mae: 2.8081, r2: 0.9337 },
  { name: 'Linear Regression', rmse: 4.6750, mae: 3.2099, r2: 0.9242 },
  { name: 'Random Forest', rmse: 6.5554, mae: 4.4381, r2: 0.8509 },
];

function App() {
  const [activePage, setActivePage] = useState('Overview');
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

  const [gradientData, setGradientData] = useState(null);
  const [gradientLoading, setGradientLoading] = useState(false);
  const [gradientError, setGradientError] = useState('');
  const [gradientLogScale, setGradientLogScale] = useState(false);


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
        `http://127.0.0.1:8000/api/history?${params.toString()}`
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

  useEffect(() => {
    if (activePage === 'History') loadFilteredHistory();
  }, [activePage]);

  useEffect(() => {
    if (activePage === 'Gradient Descent' && !gradientData && !gradientLoading) {
      loadGradientDescent();
    }
  }, [activePage, gradientData, gradientLoading]);



  async function loadGradientDescent() {
    setGradientLoading(true);
    setGradientError('');

    try {
      const response = await fetch('http://127.0.0.1:8000/api/gradient-descent');
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.detail || 'Could not load gradient descent history.');
      }

      setGradientData(result);
    } catch (error) {
      setGradientError(error.message || 'Could not connect to the gradient descent API.');
    } finally {
      setGradientLoading(false);
    }
  }

  async function requestPrediction() {
    setPredicting(true);
    setPredictionError('');
    setPrediction(null);
    try {
      const response = await fetch('http://127.0.0.1:8000/api/predict');
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
          fetch('http://127.0.0.1:8000/api/summary'),
          fetch('http://127.0.0.1:8000/api/history?limit=24')
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
      } catch (error) {
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
    Models: 'Compare models on the untouched test set.',
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
            ['Models', '⌘'],
          ].map(([page, symbol]) => (
            <button
              key={page}
              className={`nav-item ${activePage === page ? 'active' : ''}`}
              onClick={() => setActivePage(page)}
            >
              <span className="nav-symbol">{symbol}</span>
              {page}
              {page === 'Forecast' && <span className="nav-dot" />}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="location-card">
            <span className="location-icon">⌖</span>
            <div>
              <span className="location-label">MONITORING LOCATION</span>
              <strong>Bengaluru, India</strong>
              <span className="location-sub">BTM Layout CPCB station</span>
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
          <div className="topbar-right">
            <span className="dataset-tag"><span /> HISTORICAL DATA</span>
            <div className="avatar">A</div>
          </div>
        </header>

        <section className="page-heading">
          <div>
            <div className="eyebrow"><span className="eyebrow-line" /> AIR QUALITY INTELLIGENCE</div>
            <h1>{activePage === 'Overview' ? <>A clearer view of<br /><span>the air you breathe.</span></> : activePage}</h1>
            <p>{pageSubtitle} Historical observations from the BTM Layout monitoring station.</p>
          </div>
          <div className="heading-date">
            <span className="calendar-icon">▦</span>
            <div><span>DATA PERIOD</span><strong>2024 — 2025</strong></div>
          </div>
        </section>

        {apiError && <section className="notice"><span className="notice-icon">!</span><p>{apiError}</p></section>}

        <section className="notice">
          <span className="notice-icon">i</span>
          <p><strong>Historical data</strong> — dashboard readings are loaded from the AirAware API and the project's hourly dataset. This is not a live sensor feed. The forecast card shows a historical-model estimate, not current air quality.</p>
        </section>

        {activePage === 'Overview' && (
          <>
            <div className="section-title-row">
              <div><h2>Air quality overview</h2><p>PM₂.₅ concentration · historical observations</p></div>
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
          </>
        )}


        {activePage === 'History' && (
          <section className="history-view">
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
          </section>
        )}

        {activePage === 'Forecast' && (
          <section className="panel placeholder-panel">
            <div className="placeholder-icon">⌁</div>
            <h2>Next-hour PM₂.₅ prediction</h2>
            <p>Generate an estimate using the saved Linear Regression model and the latest available historical observation.</p>

            <div className="forecast-fields">
              <label>Latest observed PM₂.₅
                <input type="text" value={prediction ? `${prediction.input_pm25} µg/m³` : 'Loaded from historical data'} readOnly />
              </label>
              <label>Model
                <input type="text" value="Linear Regression" readOnly />
              </label>
            </div>

            <button className="primary-button" onClick={requestPrediction} disabled={predicting}>
              {predicting ? 'Generating estimate…' : 'Generate next-hour estimate'}
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
          </section>
        )}

        {activePage === 'Gradient Descent' && (
          <section className="gradient-page">
            {gradientLoading && (
              <article className="panel"><p>Loading gradient descent training history…</p></article>
            )}

            {gradientError && (
              <article className="panel model-warning">
                <strong>Could not load training history</strong>
                <p>{gradientError}</p>
                <button className="primary-button" onClick={loadGradientDescent}>
                  Retry
                </button>
              </article>
            )}

            {gradientData && !gradientError && (
              <>
                <div className="metrics-grid gradient-metrics-grid">
                  <article className="panel metric-card">
                    <span className="metric-label">INITIAL TRAINING MSE</span>
                    <div className="metric-value">{gradientData.initial_mse.toFixed(2)}</div>
                    <span className="metric-note">At the first recorded checkpoint</span>
                  </article>
                  <article className="panel metric-card">
                    <span className="metric-label">FINAL TRAINING MSE</span>
                    <div className="metric-value">{gradientData.final_recorded_mse.toFixed(2)}</div>
                    <span className="metric-note">At epoch {gradientData.checkpoints[gradientData.checkpoints.length - 1]?.epoch ?? '—'}</span>
                  </article>
                  <article className="panel metric-card">
                    <span className="metric-label">LOSS REDUCTION</span>
                    <div className="metric-value">{gradientData.loss_reduction_percent.toFixed(2)}<span>%</span></div>
                    <span className="metric-note">Reduction in recorded training MSE</span>
                  </article>
                </div>

                <article className="panel chart-panel" style={{ marginTop: 22 }}>
                  <div className="panel-heading">
                    <div>
                      <h3>Training loss over time</h3>
                      <p>Mean squared error at each saved checkpoint</p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <button
                        className="primary-button"
                        onClick={() => setGradientLogScale((current) => !current)}
                      >
                        {gradientLogScale ? 'Log scale' : 'Linear scale'} · Switch
                      </button>
                      <span className="chart-period">BATCH GRADIENT DESCENT</span>
                    </div>
                  </div>
                  <div className="chart-legend"><span /> Training MSE · {gradientLogScale ? 'logarithmic scale' : 'linear scale'}</div>
                  <div className="chart-wrap">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={gradientData.checkpoints} margin={{ top: 12, right: 8, left: -18, bottom: 0 }}>
                        <CartesianGrid stroke="#24342F" strokeDasharray="3 5" vertical={false} />
                        <XAxis dataKey="epoch" type="number" domain={['dataMin', 'dataMax']} tick={{ fill: '#7F938B', fontSize: 11 }} axisLine={false} tickLine={false} />
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
                          contentStyle={{ background: '#14221D', border: '1px solid #31483E', borderRadius: 10, color: '#EAF5EF' }}
                        />
                        <Area type="monotone" dataKey="mse" name="Training MSE" stroke="#67D8B0" strokeWidth={2.5} fill="#67D8B0" fillOpacity={0.12} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="chart-footnote">Training loss is recorded every {gradientData.checkpoint_interval} epochs. Lower MSE indicates lower average squared prediction error on the training set.</div>
                </article>

                <article className="panel models-panel" style={{ marginTop: 22 }}>
                  <div className="panel-heading">
                    <div><h3>Optimization configuration</h3><p>Linear Regression trained from scratch</p></div>
                    <span className="unit-pill">TRAINING DETAILS</span>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <tbody>
                        <tr><th>Optimizer</th><td>{gradientData.optimizer}</td></tr>
                        <tr><th>Loss function</th><td>{gradientData.loss_function}</td></tr>
                        <tr><th>Learning rate</th><td>{gradientData.learning_rate}</td></tr>
                        <tr><th>Training epochs</th><td>{gradientData.training_epochs.toLocaleString()}</td></tr>
                        <tr><th>Training rows</th><td>{gradientData.training_rows.toLocaleString()}</td></tr>
                        <tr><th>Loss units</th><td>{gradientData.unit}</td></tr>
                      </tbody>
                    </table>
                  </div>
                  <div className="model-warning">
                    <strong>What this means</strong>
                    <p>Batch gradient descent updates model weights and bias using the gradient of the mean squared error. The falling training loss shows optimization progress; it does not guarantee better performance on unseen data.</p>
                  </div>
                </article>
              </>
            )}
          </section>
        )}

        {activePage === 'Models' && (
          <section className="panel models-panel">
            <div className="panel-heading"><div><h3>Test-set model comparison</h3><p>Untouched chronological test split · saved evaluation</p></div><span className="unit-pill">REAL RESULTS</span></div>
            <div className="table-wrap">
              <table><thead><tr><th>MODEL</th><th>RMSE ↓</th><th>MAE ↓</th><th>R² ↑</th></tr></thead>
                <tbody>{models.map((model) => <tr key={model.name}><td>{model.name}{model.name === 'Persistence baseline' && <span className="best-tag">BEST RMSE</span>}</td><td>{model.rmse.toFixed(4)}</td><td>{model.mae.toFixed(4)}</td><td>{model.r2.toFixed(4)}</td></tr>)}</tbody>
              </table>
            </div>
            <div className="model-warning"><strong>Important finding</strong><p>The persistence baseline outperformed the trained models on the held-out test set. Do not assume a trained model is better simply because its validation score was lower.</p></div>
            <button className="text-button" onClick={() => setShowModels(!showModels)}>{showModels ? 'Hide metric definitions −' : 'Explain the metrics +'}</button>
            {showModels && <div className="metric-definitions"><p><strong>RMSE:</strong> Penalizes larger prediction errors; lower is better.</p><p><strong>MAE:</strong> Average absolute prediction error in µg/m³; lower is better.</p><p><strong>R²:</strong> Variance explained relative to a mean-prediction reference; higher is better, but interpret it alongside error metrics and the baseline.</p></div>}
          </section>
        )}

        <footer className="footer"><span>airaware<span className="brand-period">.</span> <span className="footer-muted">Environmental intelligence, made understandable.</span></span><span>BUILT WITH DATA · NOT LIVE AQI</span></footer>
      </main>
    </div>
  );
}

export default App;
