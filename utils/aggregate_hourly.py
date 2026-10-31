
from pathlib import Path

import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parent.parent

INPUT_FILE = PROJECT_ROOT / "data" / "processed" / "bangalore_cpcb_cleaned.csv"
OUTPUT_FILE = PROJECT_ROOT / "data" / "processed" / "bangalore_hourly.csv"

TIMESTAMP_COL = "Timestamp"

POLLUTANT_COLS = [
    "PM2.5 (µg/m³)",
    "PM10 (µg/m³)",
    "NO2 (µg/m³)",
    "SO2 (µg/m³)",
    "Ozone (µg/m³)",
    "CO (mg/m³)",
]

WEATHER_COLS = [
    "RH (%)",
    "WS (m/s)",
    "WD (deg)",
    "SR (W/mt2)",
    "VWS (m/s)",
]


def main():
    print("Loading cleaned CPCB data...")
    df = pd.read_csv(INPUT_FILE, low_memory=False)

    # Keep timestamps in UTC to align with Open-Meteo weather data.
    df[TIMESTAMP_COL] = pd.to_datetime(
        df[TIMESTAMP_COL], utc=True, errors="coerce"
    )
    df = df.dropna(subset=[TIMESTAMP_COL])

    selected_cols = [TIMESTAMP_COL, *POLLUTANT_COLS, *WEATHER_COLS]
    df = df[selected_cols].copy()
    df = df.set_index(TIMESTAMP_COL).sort_index()

    # Aggregate 15-minute readings into UTC clock hours.
    hourly = df.resample("1h").mean()
    pollutant_counts = df[POLLUTANT_COLS].resample("1h").count()

    # Require at least two valid readings per hour for each pollutant.
    for col in POLLUTANT_COLS:
        hourly.loc[pollutant_counts[col] < 2, col] = float("nan")

    hourly.index.name = "timestamp"
    hourly = hourly.reset_index()

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    hourly.to_csv(OUTPUT_FILE, index=False)

    print("\nHourly aggregation complete!")
    print(f"Hourly rows: {len(hourly):,}")
    print(f"First timestamp: {hourly['timestamp'].min()}")
    print(f"Last timestamp: {hourly['timestamp'].max()}")
    print(f"Saved to: {OUTPUT_FILE.relative_to(PROJECT_ROOT)}")

    print("\nMissing values after aggregation:")
    print(hourly.isna().sum().to_string())

    print("\nFirst 5 hourly records:")
    print(hourly.head().to_string(index=False))


if __name__ == "__main__":
    main()
