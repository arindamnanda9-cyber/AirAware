"""API router for Kadubeesanahalli Historical AQI (2017–2023).

Strictly independent of the existing PM2.5 prediction models.
Source: Central Pollution Control Board (CPCB) via OpenCity.
"""

from __future__ import annotations

from functools import lru_cache
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd
from fastapi import APIRouter, HTTPException, Query


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_PATH = BASE_DIR / "data" / "processed" / "aqi" / "kadubeesanahalli_aqi_processed.csv"
REGISTRY_PATH = BASE_DIR / "config" / "historical_aqi_stations.json"

router = APIRouter(
    prefix="/api/historical-aqi",
    tags=["Historical AQI"],
)


@lru_cache(maxsize=1)
def load_aqi_registry() -> Dict[str, Any]:
    """Load station metadata registry with caching."""
    if not REGISTRY_PATH.exists():
        raise HTTPException(
            status_code=503,
            detail="Historical AQI station registry not found",
        )
    try:
        with REGISTRY_PATH.open(encoding="utf-8") as f:
            registry = json.load(f)
        if not isinstance(registry.get("stations"), list):
            raise ValueError("Registry must contain a stations list")
        return registry
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not load historical AQI station registry: {exc}",
        )


@lru_cache(maxsize=1)
def load_aqi_data() -> pd.DataFrame:
    """Load processed historical AQI dataset with caching."""
    if not DATA_PATH.exists():
        raise HTTPException(
            status_code=503,
            detail="Historical AQI dataset not found",
        )
    try:
        df = pd.read_csv(
            DATA_PATH,
            dtype={
                "timestamp": str,
                "station_id": str,
                "timezone_status": str,
                "possible_upper_cap": bool,
            },
        )
        df["aqi"] = pd.to_numeric(df["aqi"], errors="coerce")
        df["parsed_timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
        df = df.sort_values("parsed_timestamp").reset_index(drop=True)
        return df
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not load historical AQI dataset: {exc}",
        )


@router.get("/station")
def get_station_metadata() -> Dict[str, Any]:
    """Return historical AQI station metadata, coordinates, and limitations."""
    registry = load_aqi_registry()
    stations = registry.get("stations", [])
    if not stations:
        raise HTTPException(status_code=404, detail="No historical stations configured")

    station = stations[0]
    return {
        "station_id": station.get("station_id"),
        "name": station.get("name"),
        "latitude": station.get("latitude"),
        "longitude": station.get("longitude"),
        "coordinate_status": station.get("coordinate_status", "provisional"),
        "parameter": station.get("parameter", "AQI"),
        "unit": station.get("unit", "AQI index"),
        "timezone_status": station.get("timezone_status", "unverified_source_local"),
        "source": registry.get("source", {}),
        "is_live": False,
        "note": "Historical CPCB AQI data only. Completely separate from PM2.5 prediction model.",
    }


@router.get("/summary")
def get_historical_summary(
    year: Optional[int] = Query(None, description="Optional year filter between 2017 and 2023"),
) -> Dict[str, Any]:
    """Return summary statistics, valid/missing counts, and 500 cap counts."""
    df = load_aqi_data()
    registry = load_aqi_registry()

    filtered = df
    if year is not None:
        filtered = df[df["parsed_timestamp"].dt.year == year]
        if filtered.empty:
            raise HTTPException(
                status_code=404,
                detail=f"No data available for year {year}. Available years: 2017–2023",
            )

    total_records = len(filtered)
    valid_count = int(filtered["aqi"].notna().sum())
    missing_count = int(filtered["aqi"].isna().sum())
    capped_count = int(filtered["possible_upper_cap"].sum())

    min_val = float(filtered["aqi"].min()) if valid_count > 0 else None
    max_val = float(filtered["aqi"].max()) if valid_count > 0 else None
    mean_val = round(float(filtered["aqi"].mean()), 2) if valid_count > 0 else None

    date_start = filtered["timestamp"].iloc[0] if total_records > 0 else None
    date_end = filtered["timestamp"].iloc[-1] if total_records > 0 else None

    return {
        "station_id": "bwssb_kadubeesanahalli",
        "station_name": "BWSSB Kadubeesanahalli, Bengaluru - CPCB",
        "parameter": "AQI",
        "filter_year": year,
        "total_hourly_slots": total_records,
        "valid_readings": valid_count,
        "missing_readings": missing_count,
        "data_completeness_percent": round((valid_count / total_records * 100), 2) if total_records > 0 else 0.0,
        "capped_500_readings": capped_count,
        "min_aqi": min_val,
        "max_aqi": max_val,
        "mean_aqi": mean_val,
        "date_range": {
            "start": date_start,
            "end": date_end,
        },
        "timezone_confidence": registry.get("source", {}).get("timezone_confidence", {}),
        "coordinate_confidence": registry.get("source", {}).get("coordinate_confidence", {}),
        "is_live": False,
        "model_isolation": "This dataset is strictly isolated from the PM2.5 prediction model.",
    }


@router.get("/timeseries")
def get_historical_timeseries(
    start_date: Optional[str] = Query(None, description="Start date (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)"),
    end_date: Optional[str] = Query(None, description="End date (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)"),
    year: Optional[int] = Query(None, ge=2017, le=2023, description="Optional year filter (2017–2023)"),
    month: Optional[int] = Query(None, ge=1, le=12, description="Optional month filter (1–12)"),
    limit: int = Query(500, ge=1, le=10000, description="Max number of records to return"),
    offset: int = Query(0, ge=0, description="Pagination offset"),
    include_missing: bool = Query(True, description="Whether to include null/missing AQI slots"),
) -> Dict[str, Any]:
    """Return historical AQI time-series observations."""
    df = load_aqi_data()
    filtered = df

    if year is not None:
        filtered = filtered[filtered["parsed_timestamp"].dt.year == year]

    if month is not None:
        filtered = filtered[filtered["parsed_timestamp"].dt.month == month]

    if start_date:
        try:
            start_dt = pd.to_datetime(start_date)
            filtered = filtered[filtered["parsed_timestamp"] >= start_dt]
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid start_date format")

    if end_date:
        try:
            if len(end_date.strip()) == 10:
                end_dt = pd.to_datetime(end_date.strip()) + pd.Timedelta(days=1)
                filtered = filtered[filtered["parsed_timestamp"] < end_dt]
            else:
                end_dt = pd.to_datetime(end_date)
                filtered = filtered[filtered["parsed_timestamp"] <= end_dt]
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid end_date format")

    if not include_missing:
        filtered = filtered[filtered["aqi"].notna()]

    total_matched = len(filtered)
    paged = filtered.iloc[offset : offset + limit]

    readings = []
    for _, row in paged.iterrows():
        aqi_val = None if pd.isna(row["aqi"]) else round(float(row["aqi"]), 2)
        readings.append({
            "timestamp": row["timestamp"],
            "aqi": aqi_val,
            "possible_upper_cap": bool(row["possible_upper_cap"]),
        })

    return {
        "station_id": "bwssb_kadubeesanahalli",
        "station_name": "BWSSB Kadubeesanahalli, Bengaluru - CPCB",
        "parameter": "AQI",
        "total_matched": total_matched,
        "limit": limit,
        "offset": offset,
        "returned_count": len(readings),
        "timezone_status": "unverified_source_local",
        "is_live": False,
        "readings": readings,
    }
