"""
AirAware Pollution-Aware Routing API Module.

This module provides route recommendations between origin and destination coordinates
in the greater Bengaluru metropolitan region. It queries OpenStreetMap's OSRM routing
engine for driving route alternatives, samples each route at approximately 500-meter
intervals, and estimates historical PM2.5 exposure along each path using Inverse Distance
Weighting (IDW) interpolation from nearby active monitoring stations.

IMPORTANT DISCLAIMER:
All pollution values produced by this module are HISTORICAL ESTIMATES based on
observed 2024-2025 station observations matched by departure hour and day-of-week.
They represent typical historical conditions and must NEVER be presented as live sensor
readings or real-time air quality forecasts (is_live: false, data_type: historical_estimate).
"""

from datetime import datetime
from functools import lru_cache
import json
import math
from pathlib import Path
import time
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, status
import httpx
import pandas as pd
from pydantic import BaseModel, Field

# Base directories and dataset paths
BASE_DIR = Path(__file__).resolve().parent.parent

REGISTRY_PATH = (
    BASE_DIR
    / "config"
    / "citywide_stations_expanded.json"
)

DATA_PATH = (
    BASE_DIR
    / "data"
    / "processed"
    / "citywide"
    / "bengaluru_stations_15min_expanded.csv"
)

# Stations without valid PM2.5 measurements (0 valid records in 2024-2025 dataset)
EXCLUDED_STATION_IDS = {"site_165", "site_166"}

# Greater Bengaluru metropolitan bounding box for geographic validation
BENGALURU_BOUNDS = {
    "min_lat": 12.50,
    "max_lat": 13.50,
    "min_lon": 77.20,
    "max_lon": 78.00,
}

# OSRM public routing API endpoint
OSRM_ROUTE_URL = (
    "https://router.project-osrm.org/route/v1/driving/{lon1},{lat1};{lon2},{lat2}"
)
OSRM_TIMEOUT_SECONDS = 15.0

# Open-Meteo API for real-time and scheduled atmospheric estimates
OPEN_METEO_AQI_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
OPEN_METEO_TIMEOUT = 10.0

# Route sampling interval in kilometers (~500 meters)
SAMPLE_STEP_KM = 0.5

# Inverse Distance Weighting parameters
IDW_POWER = 2.0
IDW_NEAREST_K = 3

# In-memory cache for live coordinate PM2.5 samples: (grid_lat, grid_lon) -> (pm25, timestamp)
_ROUTE_LIVE_CACHE: Dict[Tuple[float, float], Tuple[float, float]] = {}
_ROUTE_LIVE_CACHE_TTL: float = 300.0  # 5 minutes

router = APIRouter(
    prefix="/api/routes",
    tags=["Pollution-Aware Routing"],
)


# ============================================================================
# Pydantic Schemas
# ============================================================================

class RouteRecommendationRequest(BaseModel):
    """Request payload for pollution-aware route recommendation."""
    origin_lat: float = Field(
        ...,
        description="Origin latitude (-90 to 90 degrees, within Bengaluru region)",
        examples=[12.9716],
    )
    origin_lon: float = Field(
        ...,
        description="Origin longitude (-180 to 180 degrees, within Bengaluru region)",
        examples=[77.5946],
    )
    destination_lat: float = Field(
        ...,
        description="Destination latitude (-90 to 90 degrees, within Bengaluru region)",
        examples=[12.9166],
    )
    destination_lon: float = Field(
        ...,
        description="Destination longitude (-180 to 180 degrees, within Bengaluru region)",
        examples=[77.6101],
    )
    departure_hour: int = Field(
        ...,
        ge=0,
        le=23,
        description="Departure hour of the day (0 to 23 in Asia/Kolkata local time)",
        examples=[8],
    )
    departure_weekday: int = Field(
        ...,
        ge=0,
        le=6,
        description="Departure weekday (0=Monday, 1=Tuesday, ..., 6=Sunday)",
        examples=[0],
    )
    mode: Optional[str] = Field(
        default="live",
        description="Calculation mode: 'live' (real-time atmospheric estimates from Open-Meteo) or 'historical' (2024-2025 ground station baseline)",
        examples=["live"],
    )


class SamplePointPM25(BaseModel):
    """Estimated PM2.5 observation at a sampled route point."""
    point_index: int
    latitude: float
    longitude: float
    distance_from_origin_km: float
    estimated_pm25: float
    live_pm25: Optional[float] = None
    historical_pm25: Optional[float] = None
    nearest_station_id: str
    nearest_station_name: str
    nearest_station_distance_km: float


class RouteCoverageSummary(BaseModel):
    """Spatial coverage metrics and uncertainty evaluation for a route."""
    coverage_quality: str
    min_nearest_station_km: float
    max_nearest_station_km: float
    avg_nearest_station_km: float
    uncertainty_notes: List[str]


class RouteAlternative(BaseModel):
    """Detailed evaluation of an alternative driving route."""
    route_index: int
    summary: str
    distance_km: float
    duration_min: float
    estimated_mean_pm25: float
    estimated_cumulative_exposure: float
    live_mean_pm25: Optional[float] = None
    live_cumulative_exposure: Optional[float] = None
    historical_mean_pm25: Optional[float] = None
    historical_cumulative_exposure: Optional[float] = None
    exposure_mode: str = "live_atmospheric"
    rank_by_pm25: int
    rank_by_duration: int
    rank_by_exposure: int
    is_cleanest: bool
    is_fastest: bool
    tradeoff_analysis: str
    sampled_points_count: int
    coverage: RouteCoverageSummary
    geometry: Dict[str, Any]
    sample_points: List[SamplePointPM25]


class RouteRecommendationResponse(BaseModel):
    """Response containing evaluated route alternatives and comparative analysis."""
    status: str
    data_type: str
    is_live: bool
    exposure_mode: str = "live_atmospheric"
    fallback_used: bool = False
    disclaimer: str
    calculation_methodology: str = ""
    spatial_resolution_note: str = ""
    source: str = ""
    departure_context: Dict[str, Any]
    routes_count: int
    recommended_route_index: int
    fastest_route_index: int
    tradeoff_summary: str
    routes: List[RouteAlternative]
    monitoring_stations_used: List[Dict[str, Any]]


# ============================================================================
# Geographic & Interpolation Utilities
# ============================================================================

def haversine_distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate the great-circle distance between two points in kilometers."""
    r_km = 6371.0088
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)

    a = (
        math.sin(dphi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2.0) ** 2
    )
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return r_km * c


def sample_route_coordinates(
    coordinates: List[List[float]],
    step_km: float = SAMPLE_STEP_KM,
) -> List[Tuple[float, float, float]]:
    """
    Sample points along a GeoJSON LineString coordinate list at approximately step_km intervals.

    Args:
        coordinates: List of [longitude, latitude] coordinate pairs from OSRM GeoJSON.
        step_km: Target distance between consecutive sample points in kilometers.

    Returns:
        List of tuples: (latitude, longitude, cumulative_distance_km).
    """
    if not coordinates:
        return []

    # First point: (lat, lon, 0.0)
    p0_lat, p0_lon = coordinates[0][1], coordinates[0][0]
    sampled: List[Tuple[float, float, float]] = [(p0_lat, p0_lon, 0.0)]

    accumulated_since_sample = 0.0
    total_distance_along_route = 0.0

    for i in range(len(coordinates) - 1):
        lon1, lat1 = coordinates[i]
        lon2, lat2 = coordinates[i + 1]

        seg_dist = haversine_distance_km(lat1, lon1, lat2, lon2)
        if seg_dist <= 1e-7:
            continue

        curr_lat, curr_lon = lat1, lon1
        curr_seg_remaining = seg_dist

        while accumulated_since_sample + curr_seg_remaining >= step_km:
            needed = step_km - accumulated_since_sample
            fraction = needed / curr_seg_remaining

            new_lat = curr_lat + fraction * (lat2 - curr_lat)
            new_lon = curr_lon + fraction * (lon2 - curr_lon)

            total_distance_along_route += needed
            sampled.append((new_lat, new_lon, round(total_distance_along_route, 3)))

            curr_lat, curr_lon = new_lat, new_lon
            curr_seg_remaining = haversine_distance_km(curr_lat, curr_lon, lat2, lon2)
            accumulated_since_sample = 0.0

        accumulated_since_sample += curr_seg_remaining
        total_distance_along_route += curr_seg_remaining

    # Ensure the destination point is represented if not immediately adjacent to last sample
    end_lat, end_lon = coordinates[-1][1], coordinates[-1][0]
    if haversine_distance_km(sampled[-1][0], sampled[-1][1], end_lat, end_lon) > 0.08:
        sampled.append((end_lat, end_lon, round(total_distance_along_route, 3)))

    return sampled


# ============================================================================
# Data Loading and Station Aggregations (Cached)
# ============================================================================

@lru_cache(maxsize=1)
def load_valid_stations_registry() -> List[Dict[str, Any]]:
    """
    Load monitoring stations registry and filter out stations without valid PM2.5.
    Excludes site_165 and site_166.
    """
    if not REGISTRY_PATH.exists():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Station registry file not found.",
        )

    try:
        with REGISTRY_PATH.open(encoding="utf-8") as f:
            registry = json.load(f)

        stations = registry.get("stations", [])
        valid_stations = [
            station for station in stations
            if station.get("station_id") not in EXCLUDED_STATION_IDS
            and "latitude" in station
            and "longitude" in station
        ]

        if not valid_stations:
            raise ValueError("No valid stations found after filtering excluded stations.")

        return valid_stations

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Could not load station registry: {exc}",
        )


@lru_cache(maxsize=1)
def load_historical_pm25_lookup() -> Dict[Tuple[str, int, int], float]:
    """
    Precompute and cache historical mean PM2.5 per station, weekday, and hour.

    Reads data/processed/citywide/bengaluru_stations_15min_expanded.csv once.
    Converts timestamps to Asia/Kolkata local time to derive hour (0-23) and weekday (0-6).
    Excludes null/missing observations without treating them as zero.

    Returns:
        Dict mapping (station_id, weekday, hour) -> historical mean PM2.5 in µg/m³.
    """
    if not DATA_PATH.exists():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Historical citywide dataset not found for route exposure estimation.",
        )

    try:
        # Load only required columns to minimize memory footprint
        data = pd.read_csv(
            DATA_PATH,
            usecols=["Station ID", "Timestamp", "PM2.5 (µg/m³)"],
        )

        data = data[~data["Station ID"].isin(EXCLUDED_STATION_IDS)].copy()
        data["PM2.5 (µg/m³)"] = pd.to_numeric(data["PM2.5 (µg/m³)"], errors="coerce")

        # Exclude missing observations — do not impute zero
        data = data.dropna(subset=["Station ID", "Timestamp", "PM2.5 (µg/m³)"]).copy()

        # Parse UTC timestamp and convert to Asia/Kolkata local time
        data["Timestamp"] = pd.to_datetime(data["Timestamp"], utc=True, errors="coerce")
        data = data.dropna(subset=["Timestamp"]).copy()

        local_times = data["Timestamp"].dt.tz_convert("Asia/Kolkata")
        data["hour"] = local_times.dt.hour
        data["weekday"] = local_times.dt.day_of_week

        # Compute historical mean PM2.5 per station, weekday, and hour
        grouped = (
            data.groupby(["Station ID", "weekday", "hour"])["PM2.5 (µg/m³)"]
            .mean()
            .to_dict()
        )

        return grouped

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Failed to process historical PM2.5 dataset: {exc}",
        )


def estimate_point_pm25(
    lat: float,
    lon: float,
    weekday: int,
    hour: int,
    stations: List[Dict[str, Any]],
    lookup: Dict[Tuple[str, int, int], float],
) -> Tuple[float, Dict[str, Any], float]:
    """
    Estimate PM2.5 at a specific geographic coordinate using Inverse Distance Weighting (IDW).

    Args:
        lat: Latitude of sample point.
        lon: Longitude of sample point.
        weekday: Day of week (0=Monday, 6=Sunday).
        hour: Local hour (0-23).
        stations: Valid monitoring stations list.
        lookup: Mapping (station_id, weekday, hour) -> historical mean PM2.5.

    Returns:
        Tuple of:
            - estimated_pm25: Float concentration in µg/m³
            - nearest_station: Dict representing closest monitoring station
            - nearest_distance_km: Distance to closest monitoring station
    """
    station_distances: List[Tuple[Dict[str, Any], float, float]] = []

    for station in stations:
        station_id = station["station_id"]
        val = lookup.get((station_id, weekday, hour))
        if val is None or math.isnan(val):
            continue

        dist_km = haversine_distance_km(
            lat, lon, station["latitude"], station["longitude"]
        )
        station_distances.append((station, dist_km, val))

    if not station_distances:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="No historical station observations available for the requested departure time.",
        )

    # Sort by proximity
    station_distances.sort(key=lambda item: item[1])

    nearest_station, nearest_dist_km, nearest_val = station_distances[0]

    # If extremely close to an active monitor (< 50 meters), return station value directly
    if nearest_dist_km < 0.05:
        return round(nearest_val, 2), nearest_station, round(nearest_dist_km, 3)

    # Use k-nearest stations for IDW
    top_k = station_distances[:IDW_NEAREST_K]
    weights = [1.0 / (d ** IDW_POWER) for _, d, _ in top_k]
    total_w = sum(weights)

    if total_w <= 0:
        return round(nearest_val, 2), nearest_station, round(nearest_dist_km, 3)

    estimated_pm25 = sum(w * val for (_, _, val), w in zip(top_k, weights)) / total_w
    return round(estimated_pm25, 2), nearest_station, round(nearest_dist_km, 3)


# ============================================================================
# OSRM Service Interaction
# ============================================================================

async def fetch_osrm_driving_routes(
    origin_lat: float,
    origin_lon: float,
    dest_lat: float,
    dest_lon: float,
) -> List[Dict[str, Any]]:
    """
    Fetch up to 3 alternative driving routes with full GeoJSON geometry from OSRM.

    Args:
        origin_lat, origin_lon: Start point.
        dest_lat, dest_lon: End point.

    Returns:
        List of route dictionaries from OSRM.
    """
    url = (
        f"{OSRM_ROUTE_URL.format(lon1=origin_lon, lat1=origin_lat, lon2=dest_lon, lat2=dest_lat)}"
        "?overview=full&geometries=geojson&alternatives=true"
    )

    headers = {
        "User-Agent": "AirAware-Pollution-Aware-Routing/1.0",
        "Accept": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=OSRM_TIMEOUT_SECONDS) as client:
            response = await client.get(url, headers=headers)

        if response.status_code != 200:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=(
                    f"OSRM routing service returned HTTP {response.status_code}: {response.text[:200]}"
                ),
            )

        data = response.json()
        if data.get("code") != "Ok":
            message = data.get("message", "Could not calculate driving routes.")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Routing service could not find drivable route: {message}",
            )

        routes = data.get("routes", [])
        if not routes:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No drivable road routes found between the specified coordinates.",
            )

        # Cap at 3 alternative routes as required
        return routes[:3]

    except httpx.TimeoutException:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="The OSRM routing engine timed out. Please try again.",
        )
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to communicate with OSRM routing engine: {exc}",
        )


# ============================================================================
# Route Evaluation & Trade-off Logic
# ============================================================================

# ============================================================================
# Live Route Exposure Fetching
# ============================================================================

async def fetch_live_pm25_for_sample_points(
    points: List[Tuple[float, float]],
    departure_hour: Optional[int] = None,
) -> Optional[Dict[Tuple[float, float], float]]:
    """
    Fetch live Open-Meteo PM2.5 estimates for sampled route coordinates using batching and caching.
    Returns mapping of (round(lat, 2), round(lon, 2)) -> pm25, or None on failure.
    """
    global _ROUTE_LIVE_CACHE
    now = time.time()

    # Coordinates rounded to 2 decimal places (~1.1 km) to avoid duplicate queries
    unique_grid_keys = list(set((round(p[0], 2), round(p[1], 2)) for p in points))
    needed_keys = [k for k in unique_grid_keys if k not in _ROUTE_LIVE_CACHE or (now - _ROUTE_LIVE_CACHE[k][1]) >= _ROUTE_LIVE_CACHE_TTL]

    if needed_keys:
        kolkata_now = datetime.now(ZoneInfo("Asia/Kolkata"))
        is_departure_now = (departure_hour is None or departure_hour == kolkata_now.hour)

        # Batch in chunks of up to 40 coordinates
        chunk_size = 40
        for i in range(0, len(needed_keys), chunk_size):
            chunk = needed_keys[i:i + chunk_size]
            lats_str = ",".join(str(k[0]) for k in chunk)
            lons_str = ",".join(str(k[1]) for k in chunk)

            params: Dict[str, Any] = {
                "latitude": lats_str,
                "longitude": lons_str,
                "timezone": "Asia/Kolkata",
            }
            if is_departure_now:
                params["current"] = "pm2_5"
            else:
                params["hourly"] = "pm2_5"
                params["forecast_days"] = "2"

            headers = {
                "User-Agent": "AirAware-Route-LiveExposure/1.0",
                "Accept": "application/json",
            }

            try:
                async with httpx.AsyncClient(timeout=OPEN_METEO_TIMEOUT) as client:
                    resp = await client.get(OPEN_METEO_AQI_URL, params=params, headers=headers)
                if resp.status_code != 200:
                    return None
                data = resp.json()
                if not isinstance(data, list):
                    data = [data]

                for key, item in zip(chunk, data):
                    pm_val = None
                    if is_departure_now:
                        cur = item.get("current", {})
                        pm_val = cur.get("pm2_5")
                    else:
                        hourly = item.get("hourly", {})
                        times = hourly.get("time", [])
                        pm_vals = hourly.get("pm2_5", [])
                        target_suffix = f"{departure_hour:02d}:00"
                        for t_str, val in zip(times, pm_vals):
                            if t_str.endswith(target_suffix) and val is not None:
                                pm_val = val
                                break
                    if pm_val is not None:
                        _ROUTE_LIVE_CACHE[key] = (float(pm_val), now)
            except Exception:
                return None

    # Build lookup for all unique grid keys
    result_map: Dict[Tuple[float, float], float] = {}
    for k in unique_grid_keys:
        if k in _ROUTE_LIVE_CACHE:
            result_map[k] = _ROUTE_LIVE_CACHE[k][0]

    return result_map if result_map else None


# ============================================================================
# Route Evaluation & Trade-off Logic
# ============================================================================

def evaluate_route(
    route_raw: Dict[str, Any],
    route_index: int,
    weekday: int,
    hour: int,
    stations: List[Dict[str, Any]],
    lookup: Dict[Tuple[str, int, int], float],
    live_pm25_map: Optional[Dict[Tuple[float, float], float]] = None,
    requested_mode: str = "live",
) -> Dict[str, Any]:
    """Evaluate a single raw OSRM route against historical PM2.5 observations or live Open-Meteo estimates."""
    distance_km = round(route_raw["distance"] / 1000.0, 2)
    duration_min = round(route_raw["duration"] / 60.0, 1)
    summary = route_raw.get("summary") or f"Alternative route via local roads {route_index + 1}"
    geometry = route_raw.get("geometry", {})
    coordinates = geometry.get("coordinates", [])

    if not coordinates:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"OSRM route {route_index} did not contain valid GeoJSON coordinates.",
        )

    # Sample route at ~500m intervals
    sampled_coords = sample_route_coordinates(coordinates, step_km=SAMPLE_STEP_KM)
    if not sampled_coords:
        sampled_coords = [(coordinates[0][1], coordinates[0][0], 0.0)]

    sample_points: List[SamplePointPM25] = []
    historical_pm25_values: List[float] = []
    live_pm25_values: List[float] = []
    nearest_station_dists: List[float] = []

    for pt_idx, (pt_lat, pt_lon, dist_along) in enumerate(sampled_coords):
        pm25_hist, nearest_stn, nearest_d = estimate_point_pm25(
            pt_lat, pt_lon, weekday, hour, stations, lookup
        )
        historical_pm25_values.append(pm25_hist)
        nearest_station_dists.append(nearest_d)

        pt_live: Optional[float] = None
        if live_pm25_map is not None:
            grid_key = (round(pt_lat, 2), round(pt_lon, 2))
            pt_live = live_pm25_map.get(grid_key)
            if pt_live is not None:
                live_pm25_values.append(pt_live)

        if live_pm25_map is not None and pt_live is not None and requested_mode == "live":
            effective_pm25 = pt_live
        else:
            effective_pm25 = pm25_hist

        sample_points.append(
            SamplePointPM25(
                point_index=pt_idx,
                latitude=round(pt_lat, 5),
                longitude=round(pt_lon, 5),
                distance_from_origin_km=dist_along,
                estimated_pm25=round(effective_pm25, 2),
                live_pm25=round(pt_live, 2) if pt_live is not None else None,
                historical_pm25=round(pm25_hist, 2),
                nearest_station_id=nearest_stn["station_id"],
                nearest_station_name=nearest_stn["name"],
                nearest_station_distance_km=nearest_d,
            )
        )

    hist_mean_pm25 = round(sum(historical_pm25_values) / len(historical_pm25_values), 2)
    hist_cumulative_exp = round(hist_mean_pm25 * duration_min, 2)

    has_live = bool(live_pm25_map is not None and live_pm25_values and requested_mode == "live")
    if has_live:
        live_mean_pm25 = round(sum(live_pm25_values) / len(live_pm25_values), 2)
        live_cumulative_exp = round(live_mean_pm25 * duration_min, 2)
        effective_mean_pm25 = live_mean_pm25
        effective_cumulative_exp = live_cumulative_exp
        route_exposure_mode = "live_atmospheric"
    else:
        live_mean_pm25 = None
        live_cumulative_exp = None
        effective_mean_pm25 = hist_mean_pm25
        effective_cumulative_exp = hist_cumulative_exp
        route_exposure_mode = "historical_fallback" if requested_mode == "live" else "historical_estimate"

    min_near_km = round(min(nearest_station_dists), 2)
    max_near_km = round(max(nearest_station_dists), 2)
    avg_near_km = round(sum(nearest_station_dists) / len(nearest_station_dists), 2)

    uncertainty_notes: List[str] = []
    if has_live:
        uncertainty_notes.append(
            "Live atmospheric telemetry: Sampled route points are evaluated against real-time Open-Meteo numerical atmospheric estimates."
        )
        uncertainty_notes.append(
            "Spatial model resolution: Atmospheric modeling operates on ~0.1° (~11 km) grid cells. Multiple route sample points within the same cell share identical ambient background estimates."
        )
    else:
        uncertainty_notes.append(
            "Historical baseline: PM2.5 reflects average 2024-2025 concentrations for the requested day and hour."
        )
        uncertainty_notes.append(
            "Spatial interpolation: Sampled points use Inverse Distance Weighting across the 3 nearest active monitors."
        )

    if max_near_km > 12.0:
        coverage_quality = "sparse"
        uncertainty_notes.append(
            f"Portions of this route exceed {max_near_km:.1f} km from physical ground stations."
        )
    elif max_near_km > 6.0:
        coverage_quality = "moderate"
        uncertainty_notes.append(
            f"Maximum distance to nearest ground monitor is {max_near_km:.1f} km."
        )
    else:
        coverage_quality = "good"
        uncertainty_notes.append(
            f"Dense monitoring coverage: all sample points are within {max_near_km:.1f} km of a ground monitor."
        )

    coverage_summary = RouteCoverageSummary(
        coverage_quality=coverage_quality,
        min_nearest_station_km=min_near_km,
        max_nearest_station_km=max_near_km,
        avg_nearest_station_km=avg_near_km,
        uncertainty_notes=uncertainty_notes,
    )

    return {
        "route_index": route_index,
        "summary": summary,
        "distance_km": distance_km,
        "duration_min": duration_min,
        "estimated_mean_pm25": effective_mean_pm25,
        "estimated_cumulative_exposure": effective_cumulative_exp,
        "live_mean_pm25": live_mean_pm25,
        "live_cumulative_exposure": live_cumulative_exp,
        "historical_mean_pm25": hist_mean_pm25,
        "historical_cumulative_exposure": hist_cumulative_exp,
        "exposure_mode": route_exposure_mode,
        "sampled_points_count": len(sample_points),
        "coverage": coverage_summary,
        "geometry": geometry,
        "sample_points": sample_points,
    }


def analyze_tradeoffs(evaluated_routes: List[Dict[str, Any]]) -> Tuple[int, int, str]:
    """
    Rank routes by PM2.5, duration, and exposure, and generate a trade-off explanation.

    Returns:
        Tuple of (recommended_route_index, fastest_route_index, tradeoff_summary_text).
    """
    # Rank by mean PM2.5 (lower is better)
    by_pm25 = sorted(evaluated_routes, key=lambda r: r["estimated_mean_pm25"])
    for rank, r in enumerate(by_pm25, start=1):
        r["rank_by_pm25"] = rank

    # Rank by duration (lower is better)
    by_dur = sorted(evaluated_routes, key=lambda r: r["duration_min"])
    for rank, r in enumerate(by_dur, start=1):
        r["rank_by_duration"] = rank

    # Rank by cumulative exposure (lower is better)
    by_exp = sorted(evaluated_routes, key=lambda r: r["estimated_cumulative_exposure"])
    for rank, r in enumerate(by_exp, start=1):
        r["rank_by_exposure"] = rank

    cleanest = by_pm25[0]
    fastest = by_dur[0]

    for r in evaluated_routes:
        r["is_cleanest"] = (r["route_index"] == cleanest["route_index"])
        r["is_fastest"] = (r["route_index"] == fastest["route_index"])

        notes: List[str] = []
        if r["is_cleanest"] and r["is_fastest"]:
            notes.append("Optimal choice: this route offers both the lowest estimated pollution and shortest driving time.")
        elif r["is_cleanest"]:
            time_penalty = round(r["duration_min"] - fastest["duration_min"], 1)
            dist_diff = round(r["distance_km"] - fastest["distance_km"], 1)
            pct_cleaner = round(
                (fastest["estimated_mean_pm25"] - r["estimated_mean_pm25"])
                / (fastest["estimated_mean_pm25"] or 1)
                * 100,
                1,
            )
            notes.append(
                f"Lowest estimated PM2.5 ({r['estimated_mean_pm25']} µg/m³, {pct_cleaner}% cleaner than fastest route), "
                f"at the cost of +{time_penalty} min driving time and +{dist_diff} km."
            )
        elif r["is_fastest"]:
            pollution_penalty = round(
                (r["estimated_mean_pm25"] - cleanest["estimated_mean_pm25"])
                / (cleanest["estimated_mean_pm25"] or 1)
                * 100,
                1,
            )
            time_savings = round(cleanest["duration_min"] - r["duration_min"], 1)
            notes.append(
                f"Fastest route ({r['duration_min']} min, saves {time_savings} min), "
                f"but incurs {pollution_penalty}% higher estimated average PM2.5 ({r['estimated_mean_pm25']} µg/m³)."
            )
        else:
            notes.append(
                f"Intermediate alternative ({r['duration_min']} min, {r['distance_km']} km, "
                f"mean PM2.5: {r['estimated_mean_pm25']} µg/m³)."
            )
        r["tradeoff_analysis"] = " ".join(notes)

    # Overarching comparative summary
    if len(evaluated_routes) == 1:
        tradeoff_summary = (
            f"Only one drivable route was identified ({evaluated_routes[0]['distance_km']} km, "
            f"{evaluated_routes[0]['duration_min']} min). Estimated mean PM2.5 is "
            f"{evaluated_routes[0]['estimated_mean_pm25']} µg/m³."
        )
    elif cleanest["route_index"] == fastest["route_index"]:
        tradeoff_summary = (
            f"Route {cleanest['route_index'] + 1} is both the fastest ({fastest['duration_min']} min) "
            f"and the cleanest route (mean PM2.5: {cleanest['estimated_mean_pm25']} µg/m³). "
            f"No compromise between travel time and air quality is necessary."
        )
    else:
        time_diff = round(cleanest["duration_min"] - fastest["duration_min"], 1)
        pm_diff_pct = round(
            (fastest["estimated_mean_pm25"] - cleanest["estimated_mean_pm25"])
            / (fastest["estimated_mean_pm25"] or 1)
            * 100,
            1,
        )
        tradeoff_summary = (
            f"Route {cleanest['route_index'] + 1} is recommended for lower pollution "
            f"(mean PM2.5: {cleanest['estimated_mean_pm25']} µg/m³, {pm_diff_pct}% reduction in average concentration), "
            f"requiring +{time_diff} minutes of travel compared to Route {fastest['route_index'] + 1} "
            f"({fastest['duration_min']} min, {fastest['estimated_mean_pm25']} µg/m³)."
        )

    return cleanest["route_index"], fastest["route_index"], tradeoff_summary


# ============================================================================
# API Endpoint
# ============================================================================

@router.post(
    "/recommend",
    response_model=RouteRecommendationResponse,
    summary="Recommend pollution-aware driving routes in Bengaluru",
    description=(
        "Retrieves alternative road routes between origin and destination coordinates "
        "via OSRM, samples them at ~500m intervals, and estimates PM2.5 exposure using "
        "real-time Open-Meteo atmospheric estimates with fallback to historical station profiles."
    ),
)
async def recommend_routes(request: RouteRecommendationRequest):
    """
    Compute driving route alternatives and evaluate live/historical PM2.5 exposure.
    """
    # 1. Geographic validation
    for name, lat, lon in [
        ("Origin", request.origin_lat, request.origin_lon),
        ("Destination", request.destination_lat, request.destination_lon),
    ]:
        if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"{name} coordinates ({lat}, {lon}) are not valid geographic coordinates.",
            )

        if not (
            BENGALURU_BOUNDS["min_lat"] <= lat <= BENGALURU_BOUNDS["max_lat"]
            and BENGALURU_BOUNDS["min_lon"] <= lon <= BENGALURU_BOUNDS["max_lon"]
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"{name} coordinates ({lat:.4f}, {lon:.4f}) fall outside the greater Bengaluru "
                    f"metropolitan monitoring area (lat {BENGALURU_BOUNDS['min_lat']}–{BENGALURU_BOUNDS['max_lat']}, "
                    f"lon {BENGALURU_BOUNDS['min_lon']}–{BENGALURU_BOUNDS['max_lon']})."
                ),
            )

    od_distance_km = haversine_distance_km(
        request.origin_lat, request.origin_lon, request.destination_lat, request.destination_lon
    )
    if od_distance_km < 0.05:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Origin and destination are too close to each other (minimum 50 meters required).",
        )

    # 2. Load station metadata and precomputed historical air quality aggregations
    stations = load_valid_stations_registry()
    lookup = load_historical_pm25_lookup()

    # 3. Retrieve driving routes from OSRM
    raw_routes = await fetch_osrm_driving_routes(
        request.origin_lat,
        request.origin_lon,
        request.destination_lat,
        request.destination_lon,
    )

    # 4. If requested mode is live, collect all sampled coordinates across all routes and batch fetch
    live_pm25_map: Optional[Dict[Tuple[float, float], float]] = None
    fallback_used = False
    requested_mode = (request.mode or "live").lower()

    if requested_mode != "historical":
        all_sampled_points: List[Tuple[float, float]] = []
        for r_raw in raw_routes:
            coords = r_raw.get("geometry", {}).get("coordinates", [])
            s_coords = sample_route_coordinates(coords, step_km=SAMPLE_STEP_KM)
            for sc in s_coords:
                all_sampled_points.append((sc[0], sc[1]))
        if all_sampled_points:
            live_pm25_map = await fetch_live_pm25_for_sample_points(all_sampled_points, request.departure_hour)
            if live_pm25_map is None:
                fallback_used = True

    is_live_active = bool(live_pm25_map is not None and not fallback_used and requested_mode != "historical")
    overall_exposure_mode = "live_atmospheric" if is_live_active else ("historical_fallback" if fallback_used else "historical_estimate")
    overall_data_type = "live_route_exposure" if is_live_active else "historical_estimate"

    # 5. Evaluate routes
    evaluated_routes: List[Dict[str, Any]] = []
    for idx, r_raw in enumerate(raw_routes):
        evaluated = evaluate_route(
            r_raw,
            idx,
            request.departure_weekday,
            request.departure_hour,
            stations,
            lookup,
            live_pm25_map=live_pm25_map,
            requested_mode=requested_mode,
        )
        evaluated_routes.append(evaluated)

    # 6. Rank and analyze trade-offs
    rec_idx, fast_idx, tradeoff_summary = analyze_tradeoffs(evaluated_routes)

    weekday_names = [
        "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"
    ]
    weekday_label = weekday_names[request.departure_weekday]
    hour_label = f"{request.departure_hour:02d}:00–{request.departure_hour:02d}:59 IST"

    departure_context = {
        "departure_hour": request.departure_hour,
        "departure_weekday": request.departure_weekday,
        "departure_weekday_name": weekday_label,
        "time_window": hour_label,
        "timezone": "Asia/Kolkata",
        "calculation_mode": overall_exposure_mode,
        "reference_period": "Real-time atmospheric modeling" if is_live_active else "2024–2025 citywide monitoring observations",
    }

    if is_live_active:
        source_label = "Open-Meteo Atmospheric Air Quality Model (Copernicus CAMS & ECMWF) via OSRM sampled coordinates"
        disclaimer = (
            "Live route exposure estimates are calculated by sampling road coordinates from Open-Meteo's "
            "atmospheric numerical model. They are NOT roadside physical sensor measurements (is_live: true, data_type: live_route_exposure)."
        )
        methodology = (
            "Live atmospheric route sampling: The candidate driving routes are segmented at ~500m intervals via OSRM. "
            "Real-time PM2.5 concentrations are queried from Open-Meteo atmospheric model grid cells for each sample point. "
            "Mean route PM2.5 is the arithmetic mean across all sample points, and cumulative exposure is calculated as "
            "Mean PM2.5 × Duration (min) as an exposure proxy."
        )
    elif fallback_used:
        source_label = "CPCB / KSPCB 2024–2025 ground station observations (Historical Fallback)"
        disclaimer = (
            "Live atmospheric telemetry was temporarily unavailable from Open-Meteo. Route exposure was calculated "
            "using the 2024–2025 CPCB/KSPCB ground station historical baseline matched by departure time (fallback_used: true, is_live: false)."
        )
        methodology = (
            "Historical station interpolation: The driving route is segmented at ~500m intervals via OSRM. "
            "PM2.5 concentrations are estimated using Inverse Distance Weighting (IDW, power=2) from the 3 nearest active "
            "CPCB/KSPCB stations matched by departure hour and day-of-week."
        )
    else:
        source_label = "CPCB / KSPCB 2024–2025 ground station observations"
        disclaimer = (
            "These pollution estimates are derived from historical 2024–2025 CPCB/KSPCB station observations "
            "matched by departure hour and day of week. They represent typical historical conditions and are "
            "NOT live air quality measurements or real-time forecasts (is_live: false, data_type: historical_estimate)."
        )
        methodology = (
            "Historical station interpolation: The driving route is segmented at ~500m intervals via OSRM. "
            "PM2.5 concentrations are estimated using Inverse Distance Weighting (IDW, power=2) from the 3 nearest active "
            "CPCB/KSPCB stations matched by departure hour and day-of-week."
        )

    spatial_resolution_note = (
        "Open-Meteo atmospheric numerical model operates on a ~0.1° (~11 km) spatial grid. Route segments falling within "
        "the same grid cell share identical background atmospheric estimates. This metric reflects ambient air quality "
        "rather than roadside tailpipe emissions."
    )

    used_stations = [
        {
            "station_id": s["station_id"],
            "name": s["name"],
            "latitude": s["latitude"],
            "longitude": s["longitude"],
        }
        for s in stations
    ]

    return RouteRecommendationResponse(
        status="success",
        data_type=overall_data_type,
        is_live=is_live_active,
        exposure_mode=overall_exposure_mode,
        fallback_used=fallback_used,
        disclaimer=disclaimer,
        calculation_methodology=methodology,
        spatial_resolution_note=spatial_resolution_note,
        source=source_label,
        departure_context=departure_context,
        routes_count=len(evaluated_routes),
        recommended_route_index=rec_idx,
        fastest_route_index=fast_idx,
        tradeoff_summary=tradeoff_summary,
        routes=[RouteAlternative(**r) for r in evaluated_routes],
        monitoring_stations_used=used_stations,
    )
