from functools import lru_cache
from pathlib import Path
import json

import pandas as pd
from fastapi import APIRouter, HTTPException, Query


BASE_DIR = Path(__file__).resolve().parent.parent

DATA_PATH = (
    BASE_DIR
    / "data"
    / "processed"
    / "citywide"
    / "bengaluru_stations_15min_expanded.csv"
)

REGISTRY_PATH = (
    BASE_DIR
    / "config"
    / "citywide_stations_expanded.json"
)

router = APIRouter(
    prefix="/api/citywide-expanded",
    tags=["Expanded Citywide"],
)

POLLUTANTS = {
    "pm25": ("PM2.5 (µg/m³)", "µg/m³"),
    "pm10": ("PM10 (µg/m³)", "µg/m³"),
    "no2": ("NO2 (µg/m³)", "µg/m³"),
    "so2": ("SO2 (µg/m³)", "µg/m³"),
    "co": ("CO (mg/m³)", "mg/m³"),
    "ozone": ("Ozone (µg/m³)", "µg/m³"),
}

REQUIRED_COLUMNS = [
    "Station ID",
    "Timestamp",
    *[column for column, _ in POLLUTANTS.values()],
]


@lru_cache(maxsize=1)
def load_registry():
    if not REGISTRY_PATH.exists():
        raise HTTPException(
            status_code=503,
            detail="Expanded station registry not found",
        )

    try:
        with REGISTRY_PATH.open(encoding="utf-8") as file:
            registry = json.load(file)

        if not isinstance(registry.get("stations"), list):
            raise ValueError("Registry must contain a stations list")

        station_ids = [
            station["station_id"]
            for station in registry["stations"]
        ]

        if len(station_ids) != len(set(station_ids)):
            raise ValueError("Duplicate station IDs in registry")

        return registry

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not load station registry: {exc}",
        )


@lru_cache(maxsize=1)
def load_expanded_data():
    if not DATA_PATH.exists():
        raise HTTPException(
            status_code=503,
            detail="Expanded citywide dataset not found",
        )

    try:
        data = pd.read_csv(
            DATA_PATH,
            usecols=REQUIRED_COLUMNS,
            parse_dates=["Timestamp"],
        )

        data["Timestamp"] = pd.to_datetime(
            data["Timestamp"],
            utc=True,
            errors="coerce",
        )

        data = data.dropna(
            subset=["Station ID", "Timestamp"]
        ).copy()

        for column, _ in POLLUTANTS.values():
            data[column] = pd.to_numeric(
                data[column],
                errors="coerce",
            )

        return data.sort_values(
            ["Station ID", "Timestamp"]
        ).reset_index(drop=True)

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not load expanded dataset: {exc}",
        )


@lru_cache(maxsize=1)
def get_station_groups():
    data = load_expanded_data()
    return {
        station_id: group.reset_index(drop=True)
        for station_id, group in data.groupby("Station ID")
    }


def get_station(station_id: str):
    registry = load_registry()

    station = next(
        (
            item
            for item in registry["stations"]
            if item["station_id"] == station_id
        ),
        None,
    )

    if station is None:
        raise HTTPException(
            status_code=404,
            detail="Station not found",
        )

    return station


def rounded_or_none(value):
    if pd.isna(value):
        return None
    return round(float(value), 2)


def get_latest_reading(station_data, column, unit):
    valid = station_data.dropna(subset=[column])

    if valid.empty:
        return {
            "value": None,
            "timestamp": None,
            "unit": unit,
        }

    latest = valid.iloc[-1]

    return {
        "value": rounded_or_none(latest[column]),
        "timestamp": latest["Timestamp"].isoformat(),
        "unit": unit,
    }


def daily_history(station_data, start_date, end_date):
    filtered = station_data[
        (station_data["Timestamp"] >= start_date)
        & (station_data["Timestamp"] < end_date)
    ]

    if filtered.empty:
        daily = pd.DataFrame()
    else:
        daily = (
            filtered.set_index("Timestamp")
            .resample("D")
            .agg({
                "PM2.5 (µg/m³)": ["mean", "count"],
                "PM10 (µg/m³)": ["mean", "count"],
            })
        )

    history = []

    for date in pd.date_range(
        start=start_date.normalize(),
        end=(end_date - pd.Timedelta(days=1)).normalize(),
        freq="D",
        tz="UTC",
    ):
        row = daily.loc[date] if date in daily.index else None

        history.append({
            "date": date.strftime("%Y-%m-%d"),
            "pm25": (
                rounded_or_none(row[("PM2.5 (µg/m³)", "mean")])
                if row is not None else None
            ),
            "pm10": (
                rounded_or_none(row[("PM10 (µg/m³)", "mean")])
                if row is not None else None
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

    return history


@router.get("/stations")
def get_expanded_stations():
    registry = load_registry()
    groups = get_station_groups()

    stations = []

    for station in registry["stations"]:
        station_id = station["station_id"]
        station_data = groups.get(station_id)

        item = {
            **station,
            "total_records": (
                int(len(station_data))
                if station_data is not None else 0
            ),
            "first_record": (
                station_data["Timestamp"].min().isoformat()
                if station_data is not None and not station_data.empty
                else None
            ),
            "last_record": (
                station_data["Timestamp"].max().isoformat()
                if station_data is not None and not station_data.empty
                else None
            ),
        }

        stations.append(item)

    return {
        "city": "Bengaluru",
        "data_type": "historical observations",
        "is_live": False,
        "station_count": len(stations),
        "stations": stations,
        "source": registry.get("source"),
    }


@router.get("/latest")
def get_expanded_latest_readings():
    registry = load_registry()
    groups = get_station_groups()

    readings = []

    for station in registry["stations"]:
        station_id = station["station_id"]
        station_data = groups.get(station_id)

        pollutant_readings = {}

        for key, (column, unit) in POLLUTANTS.items():
            if station_data is None:
                pollutant_readings[key] = {
                    "value": None,
                    "timestamp": None,
                    "unit": unit,
                }
            else:
                pollutant_readings[key] = get_latest_reading(
                    station_data,
                    column,
                    unit,
                )

        readings.append({
            **station,
            "readings": pollutant_readings,
        })

    return {
        "city": "Bengaluru",
        "data_type": "latest available historical observations",
        "is_live": False,
        "source_note": (
            "These readings come from the historical 2024–2025 dataset. "
            "They do not represent current air quality."
        ),
        "stations": readings,
    }


@router.get("/history/{station_id}")
def get_expanded_station_history(
    station_id: str,
    days: int = Query(default=90, ge=1, le=730),
):
    station = get_station(station_id)
    station_data = get_station_groups().get(station_id)

    if station_data is None or station_data.empty:
        raise HTTPException(
            status_code=404,
            detail="No historical observations found for this station",
        )

    last_timestamp = station_data["Timestamp"].max()
    end_date = last_timestamp.normalize() + pd.Timedelta(days=1)
    start_date = end_date - pd.Timedelta(days=days)

    return {
        "station_id": station_id,
        "station_name": station["name"],
        "data_type": "historical daily averages",
        "is_live": False,
        "period_days": days,
        "start_date": start_date.isoformat(),
        "end_date": (end_date - pd.Timedelta(nanoseconds=1)).isoformat(),
        "unit": "µg/m³",
        "history": daily_history(
            station_data,
            start_date,
            end_date,
        ),
    }


@router.get("/comparison")
def get_expanded_comparison(
    days: int = Query(default=30, ge=1, le=730),
):
    registry = load_registry()
    groups = get_station_groups()

    station_last_dates = []

    for station in registry["stations"]:
        station_data = groups.get(station["station_id"])

        if station_data is not None and not station_data.empty:
            station_last_dates.append(
                station_data["Timestamp"].max()
            )

    if not station_last_dates:
        raise HTTPException(
            status_code=503,
            detail="No station observations are available",
        )

    common_end = min(station_last_dates).normalize()
    start_date = common_end - pd.Timedelta(days=days - 1)
    end_date = common_end + pd.Timedelta(days=1)

    comparison = []

    for station in registry["stations"]:
        station_id = station["station_id"]
        station_data = groups.get(station_id)

        history = (
            daily_history(station_data, start_date, end_date)
            if station_data is not None
            else [
                {
                    "date": date.strftime("%Y-%m-%d"),
                    "pm25": None,
                    "pm10": None,
                    "pm25_count": 0,
                    "pm10_count": 0,
                }
                for date in pd.date_range(
                    start_date,
                    periods=days,
                    freq="D",
                    tz="UTC",
                )
            ]
        )

        comparison.append({
            "station_id": station_id,
            "station_name": station["name"],
            "history": history,
        })

    return {
        "city": "Bengaluru",
        "data_type": "historical daily station comparison",
        "is_live": False,
        "period_days": days,
        "start_date": start_date.strftime("%Y-%m-%d"),
        "end_date": common_end.strftime("%Y-%m-%d"),
        "unit": "µg/m³",
        "stations": comparison,
        "note": (
            "All stations use the same calendar-date window. "
            "Missing observations remain unavailable and are not treated as zero."
        ),
    }
