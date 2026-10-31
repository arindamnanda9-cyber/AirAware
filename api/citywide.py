from functools import lru_cache
from pathlib import Path
import json

import pandas as pd
from fastapi import APIRouter, HTTPException, Query


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_PATH = BASE_DIR / "data" / "processed" / "citywide" / "bengaluru_stations_15min.csv"
REGISTRY_PATH = BASE_DIR / "config" / "citywide_stations.json"

router = APIRouter(prefix="/api/citywide", tags=["Citywide"])


@lru_cache(maxsize=1)
def load_registry():
    if not REGISTRY_PATH.exists():
        raise HTTPException(status_code=503, detail="Station registry not found")

    with REGISTRY_PATH.open(encoding="utf-8") as file:
        return json.load(file)


@lru_cache(maxsize=1)
def load_citywide_data():
    if not DATA_PATH.exists():
        raise HTTPException(status_code=503, detail="Citywide dataset not found")

    try:
        data = pd.read_csv(DATA_PATH)
        required = [
            "Station ID",
            "Station Name",
            "Timestamp",
            "PM2.5 (µg/m³)",
            "PM10 (µg/m³)",
        ]

        missing = [column for column in required if column not in data.columns]
        if missing:
            raise HTTPException(
                status_code=503,
                detail=f"Citywide dataset is missing columns: {missing}",
            )

        data["Timestamp"] = pd.to_datetime(
            data["Timestamp"], utc=True, errors="coerce"
        )
        data = data.dropna(subset=["Timestamp"]).copy()

        for column in ["PM2.5 (µg/m³)", "PM10 (µg/m³)"]:
            data[column] = pd.to_numeric(data[column], errors="coerce")

        return data.sort_values("Timestamp").reset_index(drop=True)

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not load citywide dataset: {exc}",
        )


@router.get("/stations")
def get_citywide_stations():
    registry = load_registry()
    data = load_citywide_data()

    stations = []

    for station in registry["stations"]:
        station_data = data[data["Station ID"] == station["station_id"]]

        stations.append({
            **station,
            "total_records": int(len(station_data)),
            "first_record": (
                station_data["Timestamp"].min().isoformat()
                if not station_data.empty else None
            ),
            "last_record": (
                station_data["Timestamp"].max().isoformat()
                if not station_data.empty else None
            ),
        })

    return {
        "city": "Bengaluru",
        "data_type": "historical observations",
        "is_live": False,
        "station_count": len(stations),
        "stations": stations,
    }


@router.get("/latest")
def get_latest_citywide_readings():
    registry = load_registry()
    data = load_citywide_data()

    readings = []

    pollutants = {
        "pm25": "PM2.5 (µg/m³)",
        "pm10": "PM10 (µg/m³)",
    }

    for station in registry["stations"]:
        station_data = data[data["Station ID"] == station["station_id"]]

        pollutant_readings = {}

        for key, column in pollutants.items():
            valid = station_data.dropna(subset=[column])

            if valid.empty:
                pollutant_readings[key] = {
                    "value": None,
                    "timestamp": None,
                    "unit": "µg/m³",
                }
            else:
                latest = valid.iloc[-1]
                pollutant_readings[key] = {
                    "value": round(float(latest[column]), 2),
                    "timestamp": latest["Timestamp"].isoformat(),
                    "unit": "µg/m³",
                }

        readings.append({
            "station_id": station["station_id"],
            "station_name": station["name"],
            "latitude": station["latitude"],
            "longitude": station["longitude"],
            "readings": pollutant_readings,
        })

    return {
        "city": "Bengaluru",
        "data_type": "latest available historical observations",
        "is_live": False,
        "source_note": (
            "These readings are from the historical dataset. "
            "They do not represent current air quality."
        ),
        "stations": readings,
    }


@router.get("/history/{station_id}")
def get_station_history(
    station_id: str,
    days: int = Query(default=90, ge=1, le=730),
):
    registry = load_registry()
    data = load_citywide_data()

    station = next(
        (item for item in registry["stations"]
         if item["station_id"] == station_id),
        None,
    )

    if station is None:
        raise HTTPException(status_code=404, detail="Station not found")

    station_data = data[data["Station ID"] == station_id].copy()

    if station_data.empty:
        raise HTTPException(
            status_code=404,
            detail="No historical observations found for this station",
        )

    station_data = station_data.sort_values("Timestamp")
    last_timestamp = station_data["Timestamp"].max()
    start_timestamp = (
        last_timestamp.normalize() - pd.Timedelta(days=days - 1)
    )

    filtered = station_data[
        station_data["Timestamp"] >= start_timestamp
    ].copy()

    daily = (
        filtered.set_index("Timestamp")
        .resample("D")
        .agg({
            "PM2.5 (µg/m³)": ["mean", "count"],
            "PM10 (µg/m³)": ["mean", "count"],
        })
    )

    history = []

    for timestamp, row in daily.iterrows():
        pm25_mean = row[("PM2.5 (µg/m³)", "mean")]
        pm10_mean = row[("PM10 (µg/m³)", "mean")]

        history.append({
            "date": timestamp.strftime("%Y-%m-%d"),
            "pm25": (
                round(float(pm25_mean), 2)
                if pd.notna(pm25_mean) else None
            ),
            "pm10": (
                round(float(pm10_mean), 2)
                if pd.notna(pm10_mean) else None
            ),
            "pm25_count": int(row[("PM2.5 (µg/m³)", "count")]),
            "pm10_count": int(row[("PM10 (µg/m³)", "count")]),
        })

    return {
        "station_id": station_id,
        "station_name": station["name"],
        "data_type": "historical daily averages",
        "is_live": False,
        "period_days": days,
        "start_date": start_timestamp.isoformat(),
        "end_date": last_timestamp.isoformat(),
        "unit": "µg/m³",
        "history": history,
    }


@router.get("/comparison")
def get_citywide_comparison(
    days: int = Query(default=30, ge=1, le=730),
):
    registry = load_registry()
    data = load_citywide_data()

    station_ids = [station["station_id"] for station in registry["stations"]]

    station_last_dates = (
        data[data["Station ID"].isin(station_ids)]
        .groupby("Station ID")["Timestamp"]
        .max()
        .reindex(station_ids)
    )

    if station_last_dates.isna().any():
        raise HTTPException(
            status_code=503,
            detail="One or more stations have no historical coverage",
        )

    common_end_timestamp = station_last_dates.min()
    end_date = common_end_timestamp.normalize()
    start_date = end_date - pd.Timedelta(days=days - 1)

    filtered = data[
        (data["Timestamp"] >= start_date)
        & (data["Timestamp"] < end_date + pd.Timedelta(days=1))
    ].copy()

    filtered = filtered[
        filtered["Station ID"].isin(
            [station["station_id"] for station in registry["stations"]]
        )
    ]

    daily = (
        filtered.set_index("Timestamp")
        .groupby("Station ID")
        .resample("D")
        .agg({
            "PM2.5 (µg/m³)": ["mean", "count"],
            "PM10 (µg/m³)": ["mean", "count"],
        })
    )

    comparison = []

    for station in registry["stations"]:
        station_daily = daily.loc[station["station_id"]] if station["station_id"] in daily.index.get_level_values(0) else None

        records = []

        for offset in range(days):
            date = start_date + pd.Timedelta(days=offset)
            row = (
                station_daily.loc[date]
                if station_daily is not None and date in station_daily.index
                else None
            )

            records.append({
                "date": date.strftime("%Y-%m-%d"),
                "pm25": (
                    round(float(row[("PM2.5 (µg/m³)", "mean")]), 2)
                    if row is not None and pd.notna(row[("PM2.5 (µg/m³)", "mean")])
                    else None
                ),
                "pm10": (
                    round(float(row[("PM10 (µg/m³)", "mean")]), 2)
                    if row is not None and pd.notna(row[("PM10 (µg/m³)", "mean")])
                    else None
                ),
                "pm25_count": (
                    int(row[("PM2.5 (µg/m³)", "count")])
                    if row is not None else 0
                ),
                "pm10_count": (
                    int(row[("PM10 (µg/m³)", "count")])
                    if row is not None else 0
                ),
            })

        comparison.append({
            "station_id": station["station_id"],
            "station_name": station["name"],
            "history": records,
        })

    return {
        "city": "Bengaluru",
        "data_type": "historical daily station comparison",
        "is_live": False,
        "period_days": days,
        "start_date": start_date.strftime("%Y-%m-%d"),
        "end_date": end_date.strftime("%Y-%m-%d"),
        "unit": "µg/m³",
        "stations": comparison,
        "note": "All stations use the same calendar-date window. Missing observations remain unavailable and are not treated as zero.",
    }
