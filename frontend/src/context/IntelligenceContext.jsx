import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import API_BASE_URL from '../config/api.js';
import { DEFAULT_LOCATION } from '../config/locations.js';

const IntelligenceContext = createContext(null);

export function IntelligenceProvider({ children }) {
  const [activePage, setActivePage] = useState('Overview');
  const [location, setLocation] = useState(DEFAULT_LOCATION);
  const [liveAqi, setLiveAqi] = useState(null);
  const [livePrediction, setLivePrediction] = useState(null);
  const [stationsLiveAqi, setStationsLiveAqi] = useState(null);
  const [liveLoading, setLiveLoading] = useState(true);
  const [liveError, setLiveError] = useState(null);
  const [isStale, setIsStale] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);
  const [syncCount, setSyncCount] = useState(0);

  const abortRef = useRef(null);

  const refreshLiveIntelligence = useCallback(async (customLocation, force = false) => {
    const loc = customLocation || location;

    // Prevent simultaneous duplicate requests unless forced or location is changing
    if (abortRef.current && !customLocation && !force) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    setLiveLoading(true);
    setLiveError(null);

    const timestamp = Date.now();

    try {
      const [aqiResponse, predResponse, stationsResponse] = await Promise.all([
        fetch(
          `${API_BASE_URL}/live-aqi?latitude=${loc.lat}&longitude=${loc.lon}&_t=${timestamp}`,
          { signal: controller.signal, cache: 'no-store' }
        ),
        fetch(
          `${API_BASE_URL}/predict/live?latitude=${loc.lat}&longitude=${loc.lon}&_t=${timestamp}`,
          { signal: controller.signal, cache: 'no-store' }
        ),
        fetch(
          `${API_BASE_URL}/live-aqi/stations?_t=${timestamp}`,
          { signal: controller.signal, cache: 'no-store' }
        ),
      ]);

      if (!aqiResponse.ok) {
        const errorData = await aqiResponse.json().catch(() => ({}));
        throw new Error(
          errorData.detail || `Live AQI service returned status ${aqiResponse.status}`
        );
      }

      const aqiJson = await aqiResponse.json();
      const predJson = predResponse.ok ? await predResponse.json() : null;
      const stationsJson = stationsResponse.ok ? await stationsResponse.json() : null;

      if (abortRef.current === controller) {
        setLiveAqi(aqiJson);
        if (predJson) {
          setLivePrediction(predJson);
        }
        if (stationsJson) {
          setStationsLiveAqi(stationsJson);
        }
        const syncTime = new Date();
        setLastRefreshedAt(syncTime);
        setIsStale(false);
        setLiveError(null);
        setSyncCount((prev) => prev + 1);
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (abortRef.current === controller) {
        setIsStale(true);
        setLiveError(
          err.message || 'Unable to sync live intelligence services. Showing cached telemetry.'
        );
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setLiveLoading(false);
      }
    }
  }, [location]);

  const changeLocation = useCallback((newLocation) => {
    if (!newLocation) return;
    const normalized = {
      ...newLocation,
      lat: newLocation.latitude ?? newLocation.lat,
      lon: newLocation.longitude ?? newLocation.lon,
      latitude: newLocation.latitude ?? newLocation.lat,
      longitude: newLocation.longitude ?? newLocation.lon,
    };
    setLocation(normalized);
    refreshLiveIntelligence(normalized, true);
  }, [refreshLiveIntelligence]);

  useEffect(() => {
    queueMicrotask(() => {
      refreshLiveIntelligence(location, true);
    });

    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, [refreshLiveIntelligence, location]);

  const navigateTo = useCallback((page) => {
    setActivePage(page);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const value = {
    activePage,
    setActivePage,
    navigateTo,
    location,
    setLocation,
    changeLocation,
    liveAqi,
    livePrediction,
    stationsLiveAqi,
    liveLoading,
    liveError,
    isStale,
    lastRefreshedAt,
    syncCount,
    refreshLiveIntelligence,
  };

  return (
    <IntelligenceContext.Provider value={value}>
      {children}
    </IntelligenceContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useIntelligence() {
  const context = useContext(IntelligenceContext);
  if (!context) {
    throw new Error('useIntelligence must be used within an IntelligenceProvider');
  }
  return context;
}

export default IntelligenceContext;
