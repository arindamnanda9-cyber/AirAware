
from pathlib import Path

import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parent.parent

AIR_FILE = PROJECT_ROOT / "data" / "processed" / "bangalore_hourly.csv"
WEATHER_FILE = PROJECT_ROOT / "data" / "raw" / "bangalore_weather.csv"
OUTPUT_FILE = PROJECT_ROOT / "data" / "processed" / "airaware_merged.csv"


def main():
    print("Loading hourly air-quality and weather data...")

    air = pd.read_csv(AIR_FILE)
    weather = pd.read_csv(WEATHER_FILE)

    air["timestamp"] = pd.to_datetime(
        air["timestamp"], utc=True, errors="coerce"
    )
    weather["timestamp"] = pd.to_datetime(
        weather["timestamp"], utc=True, errors="coerce"
    )

    # Verify the merge key is unique in both datasets.
    if air["timestamp"].duplicated().any():
        raise ValueError("Duplicate timestamps found in air-quality data.")

    if weather["timestamp"].duplicated().any():
        raise ValueError("Duplicate timestamps found in weather data.")

    # Merge only matching hours.
    merged = pd.merge(
        air,
        weather,
        on="timestamp",
        how="inner",
        validate="one_to_one",
    )

    merged = merged.sort_values("timestamp").reset_index(drop=True)

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    merged.to_csv(OUTPUT_FILE, index=False)

    print("\nMerge complete!")
    print(f"Air-quality rows: {len(air):,}")
    print(f"Weather rows: {len(weather):,}")
    print(f"Merged rows: {len(merged):,}")
    print(f"Columns: {len(merged.columns)}")
    print(f"Date range: {merged['timestamp'].min()} to {merged['timestamp'].max()}")
    print(f"Saved to: {OUTPUT_FILE.relative_to(PROJECT_ROOT)}")

    print("\nMissing values in merged data:")
    print(merged.isna().sum().to_string())

    print("\nFirst 5 merged rows:")
    print(merged.head().to_string(index=False))


if __name__ == "__main__":
    main()
