import { useIntelligence } from '../context/IntelligenceContext.jsx';

function getAqiBadgeStyle(category) {
  const cat = (category || '').toLowerCase();
  if (cat.includes('good') && !cat.includes('very')) {
    return { bg: '#163325', text: '#77dfb2', border: '#25543d' };
  }
  if (cat.includes('fair') || cat.includes('moderate')) {
    return { bg: '#362e10', text: '#f1c40f', border: '#5c4d16' };
  }
  if (cat.includes('sensitive') || (cat.includes('poor') && !cat.includes('very') && !cat.includes('extremely'))) {
    return { bg: '#382312', text: '#f39c12', border: '#633c1a' };
  }
  if (cat.includes('very poor') || (cat.includes('unhealthy') && !cat.includes('very'))) {
    return { bg: '#3c1815', text: '#e74c3c', border: '#682620' };
  }
  if (cat.includes('very unhealthy') || cat.includes('extremely poor') || cat.includes('hazardous')) {
    return { bg: '#341639', text: '#c056d8', border: '#5b2364' };
  }
  return { bg: '#15221b', text: '#899b90', border: '#24362c' };
}

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export default function LiveAqi() {
  const {
    liveAqi: liveData,
    livePrediction,
    liveLoading: loading,
    liveError: error,
    lastRefreshedAt,
    refreshLiveIntelligence,
    navigateTo,
    location,
  } = useIntelligence();

  const formatTimestamp = (rawIso) => {
    if (!rawIso) return 'Just now';
    try {
      const date = new Date(rawIso);
      return date.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return rawIso;
    }
  };

  return (
    <section className="live-aqi-wrapper" aria-label="Live Air Quality and Forecast Section">
      <div className="section-title-row live-header-row">
        <div>
          <div className="live-title-flex">
            <h2>Live air quality &amp; next-hour forecast</h2>
            <div className="live-pill" title="Live atmospheric model estimates from Open-Meteo and ML prediction">
              <span className="live-pulse" />
              <span className="live-text">LIVE</span>
            </div>
          </div>
          <p>
            {location?.name || 'Central Bengaluru'} · Open-Meteo atmospheric model + Linear Regression pipeline
          </p>
        </div>

        <div className="live-actions">
          {lastRefreshedAt && (
            <span className="live-sync-time">
              Updated {lastRefreshedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}
            </span>
          )}
          <button
            type="button"
            className="live-refresh-button"
            onClick={() => refreshLiveIntelligence()}
            disabled={loading}
            title="Refresh shared atmospheric readings and next-hour prediction across all views"
          >
            <span className={`refresh-icon ${loading ? 'spinning' : ''}`}>↻</span>
            <span>{loading ? 'Refreshing…' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {/* Distinction Callout Banner */}
      <div className="live-distinction-banner">
        <span className="distinction-badge">ATMOSPHERIC MODEL &amp; ML ESTIMATE</span>
        <p>
          <strong>Notice:</strong> Real-time air quality readings and next-hour predictions below are numerical model estimates from{' '}
          <strong>Open-Meteo</strong> (Copernicus CAMS &amp; ECMWF) and our trained <strong>Linear Regression model</strong>. They are <strong>NOT</strong> direct physical sensor measurements from CPCB or KSPCB ground monitoring stations. Historical ground station observations appear in the sections below.
        </p>
      </div>

      {error && (
        <div className="live-error-box">
          <span className="error-icon">!</span>
          <div className="error-content">
            <strong>Unable to load live air quality</strong>
            <p>{error}</p>
          </div>
          <button
            type="button"
            className="retry-button"
            onClick={() => refreshLiveIntelligence()}
            disabled={loading}
          >
            Retry
          </button>
        </div>
      )}

      {loading && !liveData && (
        <div className="live-loading-skeleton">
          <div className="skeleton-card" />
          <div className="skeleton-card" />
          <div className="skeleton-card" />
          <div className="skeleton-card" />
        </div>
      )}

      {liveData && (
        <>
          <div className="live-cards-grid">
            {/* US AQI Card */}
            <article className="live-card live-card-primary">
              <div className="live-card-top">
                <span className="live-card-label">US AQI (EPA)</span>
                <span className="live-card-badge" style={{
                  backgroundColor: getAqiBadgeStyle(liveData.aqi?.us_aqi?.category).bg,
                  color: getAqiBadgeStyle(liveData.aqi?.us_aqi?.category).text,
                  borderColor: getAqiBadgeStyle(liveData.aqi?.us_aqi?.category).border,
                }} title={liveData.aqi?.us_aqi?.category}>
                  {liveData.aqi?.us_aqi?.category === 'Unhealthy for Sensitive Groups'
                    ? 'Sensitive Groups'
                    : (liveData.aqi?.us_aqi?.category || 'Unknown')}
                </span>
              </div>
              <div className="live-card-value-row">
                <span className="live-card-number">
                  {liveData.aqi?.us_aqi?.value ?? '—'}
                </span>
                <span className="live-card-unit">AQI</span>
              </div>
              <div className="live-card-meta">
                Scale: 0–500 · {liveData.aqi?.us_aqi?.category || 'Model estimate'}
              </div>
            </article>

            {/* European AQI Card */}
            <article className="live-card live-card-primary">
              <div className="live-card-top">
                <span className="live-card-label">EUROPEAN AQI (EEA)</span>
                <span className="live-card-badge" style={{
                  backgroundColor: getAqiBadgeStyle(liveData.aqi?.european_aqi?.category).bg,
                  color: getAqiBadgeStyle(liveData.aqi?.european_aqi?.category).text,
                  borderColor: getAqiBadgeStyle(liveData.aqi?.european_aqi?.category).border,
                }} title={liveData.aqi?.european_aqi?.category}>
                  {liveData.aqi?.european_aqi?.category || 'Unknown'}
                </span>
              </div>
              <div className="live-card-value-row">
                <span className="live-card-number">
                  {liveData.aqi?.european_aqi?.value ?? '—'}
                </span>
                <span className="live-card-unit">EAQI</span>
              </div>
              <div className="live-card-meta">
                Scale: 0–100+ · {liveData.aqi?.european_aqi?.category || 'Model estimate'}
              </div>
            </article>

            {/* CURRENT PM2.5 Card */}
            <article className="live-card live-card-current">
              <div className="live-card-top">
                <span className="live-card-label">CURRENT PM₂.₅</span>
                <span className="pollutant-tag">Current</span>
              </div>
              <div className="live-card-value-row">
                <span className="live-card-number">
                  {livePrediction?.current_pm25 != null
                    ? Number(livePrediction.current_pm25).toFixed(1)
                    : (liveData.pollutants?.pm2_5?.value != null ? Number(liveData.pollutants.pm2_5.value).toFixed(1) : '—')}
                </span>
                <span className="live-card-unit">µg/m³</span>
              </div>
              <div className="live-card-meta">
                Open-Meteo atmospheric reading at {formatTimestamp(liveData.timestamp)}
              </div>
            </article>

            {/* NEXT-HOUR PM2.5 FORECAST Card */}
            <article className="live-card live-card-forecast">
              <div className="live-card-top">
                <span className="live-card-label">NEXT-HOUR PM₂.₅</span>
                <span className="forecast-badge">ML Forecast</span>
              </div>
              <div className="live-card-value-row">
                <span className="live-card-number live-forecast-number">
                  {livePrediction?.predicted_pm25 != null
                    ? Number(livePrediction.predicted_pm25).toFixed(1)
                    : '—'}
                </span>
                <span className="live-card-unit">µg/m³</span>
                {livePrediction?.delta_pm25 != null && (
                  <span className={`delta-pill ${livePrediction.delta_pm25 > 0 ? 'delta-up' : livePrediction.delta_pm25 < 0 ? 'delta-down' : 'delta-even'}`}>
                    {livePrediction.delta_pm25 > 0 ? `+${livePrediction.delta_pm25.toFixed(1)}` : livePrediction.delta_pm25.toFixed(1)}
                  </span>
                )}
              </div>
              <div className="live-card-meta">
                Linear Regression · For {livePrediction?.forecast_timestamp ? formatTimestamp(livePrediction.forecast_timestamp) : 'next hour'}
              </div>
            </article>
          </div>

          {/* Additional Pollutants Row */}
          <div className="live-pollutants-row">
            <div className="live-mini-card">
              <span className="mini-label">PM₁₀ (Particulate)</span>
              <strong className="mini-val">
                {liveData.pollutants?.pm10?.value != null ? Number(liveData.pollutants.pm10.value).toFixed(1) : '—'}
                <span className="mini-unit"> µg/m³</span>
              </strong>
            </div>
            <div className="live-mini-card">
              <span className="mini-label">NO₂ (Nitrogen Dioxide)</span>
              <strong className="mini-val">
                {liveData.pollutants?.nitrogen_dioxide?.value != null ? Number(liveData.pollutants.nitrogen_dioxide.value).toFixed(1) : '—'}
                <span className="mini-unit"> µg/m³</span>
              </strong>
            </div>
            <div className="live-mini-card">
              <span className="mini-label">SO₂ (Sulphur Dioxide)</span>
              <strong className="mini-val">
                {liveData.pollutants?.sulphur_dioxide?.value != null ? Number(liveData.pollutants.sulphur_dioxide.value).toFixed(1) : '—'}
                <span className="mini-unit"> µg/m³</span>
              </strong>
            </div>
            <div className="live-mini-card">
              <span className="mini-label">O₃ (Surface Ozone)</span>
              <strong className="mini-val">
                {liveData.pollutants?.ozone?.value != null ? Number(liveData.pollutants.ozone.value).toFixed(1) : '—'}
                <span className="mini-unit"> µg/m³</span>
              </strong>
            </div>
            <div className="live-mini-card">
              <span className="mini-label">Coordinates &amp; Model</span>
              <strong className="mini-val mini-geo">
                12.97°N, 77.59°E · {liveData.coordinates?.elevation_m ?? 910}m asl
              </strong>
            </div>
          </div>

          {/* Live Next-Hour Forecast Details Banner */}
          {livePrediction && (
            <div className="live-forecast-details" aria-label="Model Prediction Details">
              <div className="forecast-detail-header">
                <span className="forecast-detail-tag">MODEL FORECAST DETAILS</span>
                <span className="forecast-detail-title">
                  Next-Hour PM₂.₅ ML Prediction: <strong>{livePrediction.predicted_pm25.toFixed(2)} µg/m³</strong>
                  <span className="forecast-delta-text">
                    ({livePrediction.delta_pm25 >= 0 ? `+${livePrediction.delta_pm25.toFixed(2)}` : livePrediction.delta_pm25.toFixed(2)} µg/m³ vs current)
                  </span>
                </span>
                <span className="forecast-detail-time">
                  Forecast for: {formatTimestamp(livePrediction.forecast_timestamp)} IST
                </span>
              </div>

              {livePrediction.input_features && (
                <div className="forecast-feature-chips">
                  <span className="chips-label">Model Inputs:</span>
                  <span className="feature-chip">PM₂.₅: {livePrediction.input_features['PM2.5 (µg/m³)']?.toFixed(1)} µg/m³</span>
                  <span className="feature-chip">Temp: {livePrediction.input_features.temperature_c?.toFixed(1)}°C</span>
                  <span className="feature-chip">Humidity: {livePrediction.input_features.relative_humidity_pct?.toFixed(0)}%</span>
                  <span className="feature-chip">Rain: {livePrediction.input_features.precipitation_mm?.toFixed(1)} mm</span>
                  <span className="feature-chip">Wind: {livePrediction.input_features.wind_speed_ms?.toFixed(1)} m/s</span>
                  <span className="feature-chip">Hour: {livePrediction.input_features.hour}:00</span>
                  <span className="feature-chip">Day: {DAY_NAMES[livePrediction.input_features.day_of_week] || livePrediction.input_features.day_of_week}</span>
                  <span className="feature-chip">Month: {livePrediction.input_features.month}</span>
                </div>
              )}

              <div className="forecast-action-links">
                <button
                  type="button"
                  className="intelligence-nav-link"
                  onClick={() => navigateTo('Forecast')}
                >
                  Deep-dive into Forecast &amp; Predictors →
                </button>
                <button
                  type="button"
                  className="intelligence-nav-link"
                  onClick={() => navigateTo('Models')}
                >
                  Inspect Linear Regression Pipeline &amp; Weights →
                </button>
              </div>

              <p className="forecast-disclaimer-note">
                ⓘ {livePrediction.disclaimer}
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
