
from pathlib import Path

import pandas as pd
import requests

# Project root: the AirAware directory
PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_FILE = PROJECT_ROOT / "data" / "raw" / "bangalore_weather.csv"

# Representative coordinates for Bengaluru
LATITUDE = 12.9716
LONGITUDE = 77.5946

API_URL = "https://archive-api.open-meteo.com/v1/archive"

PARAMS = {
    "latitude": LATITUDE,
    "longitude": LONGITUDE,
    "start_date": "2024-01-01",
    "end_date": "2025-12-31",
    "hourly": [
        "temperature_2m",
        "relative_humidity_2m",
        "precipitation",
        "wind_speed_10m",
    ],
    "wind_speed_unit": "ms",
    "timezone": "Asia/Kolkata",
}

def main():
    print("Requesting historical weather data for Bengaluru...")

    response = requests.get(API_URL, params=PARAMS, timeout=60)
    response.raise_for_status()
    data = response.json()

    if "hourly" not in data or "time" not in data["hourly"]:
        raise ValueError("The API response does not contain hourly weather data.")

    df = pd.DataFrame(data["hourly"])
    df = df.rename(
        columns={
            "time": "timestamp",
            "temperature_2m": "temperature_c",
            "relative_humidity_2m": "relative_humidity_pct",
            "precipitation": "precipitation_mm",
            "wind_speed_10m": "wind_speed_ms",
        }
    )

    df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
    df = df.dropna(subset=["timestamp"])
    df = df.drop_duplicates(subset=["timestamp"])
    df = df.sort_values("timestamp").reset_index(drop=True)

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUTPUT_FILE, index=False)

    print("\nWeather data collected successfully!")
    print(f"Rows: {len(df):,}")
    print(f"Date range: {df['timestamp'].min()} to {df['timestamp'].max()}")
    print(f"Saved to: {OUTPUT_FILE.relative_to(PROJECT_ROOT)}")
    print("\nFirst five rows:")
    print(df.head().to_string(index=False))
    print("\nMissing values:")
    print(df.isnull().sum().to_string())

if __name__ == "__main__":
    main()
