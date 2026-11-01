"""
AirAware Live Air Quality API Module via Open-Meteo.

This module retrieves real-time ambient air quality estimates from Open-Meteo's
atmospheric model API (Copernicus CAMS & ECMWF).

CRITICAL ATTRIBUTION & DISCLAIMER:
- is_live: true
- source: Open-Meteo
- data_type: model_estimate
These values are numerical atmospheric model estimates. They must NEVER be described
or labelled as physical ground-station observations from CPCB or KSPCB.
"""

import json
from pathlib import Path
import time
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query, status
import httpx
from pydantic import BaseModel, Field

OPEN_METEO_AQI_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
OPEN_METEO_TIMEOUT = 15.0

BASE_DIR = Path(__file__).resolve().parent.parent
STATIONS_REGISTRY_PATH = BASE_DIR / "config" / "citywide_stations_expanded.json"

_STATIONS_CACHE: Optional[Dict[str, Any]] = None
_STATIONS_CACHE_TIME: float = 0.0
_STATIONS_CACHE_TTL: float = 300.0

router = APIRouter(
    prefix="/api/live-aqi",
    tags=["Live Air Quality"],
)


def get_us_aqi_category(aqi: Optional[int]) -> str:
    """Classify US AQI value into standard EPA health advisory category."""
    if aqi is None:
        return "Unknown"
    if aqi <= 50:
        return "Good"
    if aqi <= 100:
        return "Moderate"
    if aqi <= 150:
        return "Unhealthy for Sensitive Groups"
    if aqi <= 200:
        return "Unhealthy"
    if aqi <= 300:
        return "Very Unhealthy"
    return "Hazardous"


def get_european_aqi_category(aqi: Optional[int]) -> str:
    """Classify European AQI value into standard EEA category."""
    if aqi is None:
        return "Unknown"
    if aqi <= 20:
        return "Good"
    if aqi <= 40:
        return "Fair"
    if aqi <= 60:
        return "Moderate"
    if aqi <= 80:
        return "Poor"
    if aqi <= 100:
        return "Very Poor"
    return "Extremely Poor"


class LiveAQIResponse(BaseModel):
    """Schema for live air quality estimates returned by Open-Meteo."""
    status: str
    is_live: bool
    source: str
    data_type: str
    model_attribution: str
    disclaimer: str
    coordinates: Dict[str, Any]
    timestamp: str
    timezone: str
    aqi: Dict[str, Any]
    pollutants: Dict[str, Any]


class StationLiveAQI(BaseModel):
    station_id: str
    name: str
    latitude: float
    longitude: float
    model_grid_latitude: Optional[float] = None
    model_grid_longitude: Optional[float] = None
    elevation_m: Optional[float] = None
    pm2_5: Optional[float] = None
    pm10: Optional[float] = None
    us_aqi: Optional[int] = None
    us_aqi_category: str
    european_aqi: Optional[int] = None
    european_aqi_category: str


class LiveStationsAQIResponse(BaseModel):
    status: str
    is_live: bool
    source: str
    data_type: str
    timestamp: str
    stations_count: int
    stations: List[StationLiveAQI]
    disclaimer: str
    spatial_resolution_note: str


@router.get(
    "/stations",
    response_model=LiveStationsAQIResponse,
    summary="Get live atmospheric model estimates for all Bengaluru monitoring station coordinates",
)
async def get_stations_live_aqi(force_refresh: bool = False):
    global _STATIONS_CACHE, _STATIONS_CACHE_TIME
    now = time.time()
    if not force_refresh and _STATIONS_CACHE is not None and (now - _STATIONS_CACHE_TIME) < _STATIONS_CACHE_TTL:
        return _STATIONS_CACHE

    if not STATIONS_REGISTRY_PATH.exists():
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Station registry file not found: {STATIONS_REGISTRY_PATH}",
        )

    with open(STATIONS_REGISTRY_PATH, "r", encoding="utf-8") as f:
        registry_data = json.load(f)
    stations_list = registry_data.get("stations", [])

    if not stations_list:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Station registry contains no stations",
        )

    lats = ",".join(str(s["latitude"]) for s in stations_list)
    lons = ",".join(str(s["longitude"]) for s in stations_list)

    params = {
        "latitude": lats,
        "longitude": lons,
        "current": "pm2_5,pm10,us_aqi,european_aqi",
        "timezone": "Asia/Kolkata",
    }
    headers = {
        "User-Agent": "AirAware-Live-AirQuality/1.0",
        "Accept": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=OPEN_METEO_TIMEOUT) as client:
            resp = await client.get(OPEN_METEO_AQI_URL, params=params, headers=headers)
        if resp.status_code != 200:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Open-Meteo API returned HTTP {resp.status_code}: {resp.text[:200]}",
            )
        data = resp.json()
        if not isinstance(data, list):
            data = [data]

        station_results = []
        model_time = ""
        for s, d in zip(stations_list, data):
            cur = d.get("current", {})
            if not model_time and cur.get("time"):
                model_time = cur.get("time")
            us_val = cur.get("us_aqi")
            eu_val = cur.get("european_aqi")
            station_results.append(
                StationLiveAQI(
                    station_id=s["station_id"],
                    name=s["name"],
                    latitude=s["latitude"],
                    longitude=s["longitude"],
                    model_grid_latitude=d.get("latitude"),
                    model_grid_longitude=d.get("longitude"),
                    elevation_m=d.get("elevation"),
                    pm2_5=cur.get("pm2_5"),
                    pm10=cur.get("pm10"),
                    us_aqi=us_val,
                    us_aqi_category=get_us_aqi_category(us_val),
                    european_aqi=eu_val,
                    european_aqi_category=get_european_aqi_category(eu_val),
                )
            )

        disclaimer = (
            "These readings are numerical atmospheric model grid estimates from Open-Meteo (Copernicus CAMS & ECMWF). "
            "They are NOT direct physical measurements from CPCB or KSPCB ground monitoring stations."
        )
        spatial_resolution_note = (
            "Open-Meteo atmospheric model grid resolution is ~0.1° (~11 km). Stations falling within the same atmospheric "
            "grid cell receive identical modeled background estimates."
        )

        response_payload = LiveStationsAQIResponse(
            status="success",
            is_live=True,
            source="Open-Meteo",
            data_type="model_estimate",
            timestamp=model_time or time.strftime("%Y-%m-%dT%H:%M:%S"),
            stations_count=len(station_results),
            stations=station_results,
            disclaimer=disclaimer,
            spatial_resolution_note=spatial_resolution_note,
        )

        _STATIONS_CACHE = response_payload
        _STATIONS_CACHE_TIME = now
        return response_payload

    except httpx.TimeoutException:
        if _STATIONS_CACHE is not None:
            return _STATIONS_CACHE
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="The Open-Meteo live air quality service timed out.",
        )
    except httpx.RequestError as exc:
        if _STATIONS_CACHE is not None:
            return _STATIONS_CACHE
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to connect to Open-Meteo live air quality service: {exc}",
        )


@router.get(
    "",
    response_model=LiveAQIResponse,
    summary="Get live air quality model estimates via Open-Meteo",
    description=(
        "Retrieves real-time atmospheric model air quality estimates from Open-Meteo. "
        "Returns US AQI, European AQI, PM2.5, PM10, NO2, SO2, and Ozone. "
        "Marked as is_live: true, source: Open-Meteo, data_type: model_estimate."
    ),
)
async def get_live_aqi(
    latitude: float = Query(
        default=12.9716,
        ge=-90.0,
        le=90.0,
        description="Latitude of target location (default: 12.9716 for central Bengaluru)",
    ),
    longitude: float = Query(
        default=77.5946,
        ge=-180.0,
        le=180.0,
        description="Longitude of target location (default: 77.5946 for central Bengaluru)",
    ),
):
    """
    Fetch live ambient air quality estimates from Open-Meteo for the specified location.
    """
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "current": "european_aqi,us_aqi,pm2_5,pm10,nitrogen_dioxide,sulphur_dioxide,ozone",
        "timezone": "Asia/Kolkata",
    }

    headers = {
        "User-Agent": "AirAware-Live-AirQuality/1.0",
        "Accept": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=OPEN_METEO_TIMEOUT) as client:
            response = await client.get(
                OPEN_METEO_AQI_URL,
                params=params,
                headers=headers,
            )

        if response.status_code != 200:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Open-Meteo API returned HTTP {response.status_code}: {response.text[:200]}",
            )

        data = response.json()
        current = data.get("current", {})
        if not current:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Open-Meteo response did not contain current observations.",
            )

        us_aqi_val = current.get("us_aqi")
        eu_aqi_val = current.get("european_aqi")

        disclaimer = (
            "Live air quality estimates are numerical atmospheric model estimates from Open-Meteo "
            "(Copernicus CAMS & ECMWF). They are NOT direct physical measurements from CPCB or KSPCB "
            "ground monitoring stations."
        )

        return LiveAQIResponse(
            status="success",
            is_live=True,
            source="Open-Meteo",
            data_type="model_estimate",
            model_attribution="Open-Meteo Air Quality API (Copernicus CAMS & ECMWF atmospheric modeling)",
            disclaimer=disclaimer,
            coordinates={
                "requested_latitude": latitude,
                "requested_longitude": longitude,
                "model_latitude": data.get("latitude"),
                "model_longitude": data.get("longitude"),
                "elevation_m": data.get("elevation"),
            },
            timestamp=current.get("time", ""),
            timezone=data.get("timezone", "Asia/Kolkata"),
            aqi={
                "us_aqi": {
                    "value": us_aqi_val,
                    "category": get_us_aqi_category(us_aqi_val),
                    "unit": "USAQI",
                    "scale": "0–500",
                },
                "european_aqi": {
                    "value": eu_aqi_val,
                    "category": get_european_aqi_category(eu_aqi_val),
                    "unit": "EAQI",
                    "scale": "0–100+",
                },
            },
            pollutants={
                "pm2_5": {
                    "value": current.get("pm2_5"),
                    "unit": "µg/m³",
                    "name": "PM2.5",
                    "label": "Fine Particulate Matter",
                },
                "pm10": {
                    "value": current.get("pm10"),
                    "unit": "µg/m³",
                    "name": "PM10",
                    "label": "Coarse Particulate Matter",
                },
                "nitrogen_dioxide": {
                    "value": current.get("nitrogen_dioxide"),
                    "unit": "µg/m³",
                    "name": "NO₂",
                    "label": "Nitrogen Dioxide",
                },
                "sulphur_dioxide": {
                    "value": current.get("sulphur_dioxide"),
                    "unit": "µg/m³",
                    "name": "SO₂",
                    "label": "Sulphur Dioxide",
                },
                "ozone": {
                    "value": current.get("ozone"),
                    "unit": "µg/m³",
                    "name": "O₃",
                    "label": "Surface Ozone",
                },
            },
        )

    except httpx.TimeoutException:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="The Open-Meteo live air quality service timed out. Please try again.",
        )
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to connect to Open-Meteo live air quality service: {exc}",
        )
