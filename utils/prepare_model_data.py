
from pathlib import Path

import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parent.parent
INPUT_FILE = PROJECT_ROOT / "data" / "processed" / "airaware_merged.csv"
OUTPUT_FILE = PROJECT_ROOT / "data" / "processed" / "pm25_model_data.csv"

TARGET_SOURCE = "PM2.5 (µg/m³)"

FEATURES = [
    "PM2.5 (µg/m³)",
    "PM10 (µg/m³)",
    "NO2 (µg/m³)",
    "SO2 (µg/m³)",
    "Ozone (µg/m³)",
    "CO (mg/m³)",
    "temperature_c",
    "relative_humidity_pct",
    "precipitation_mm",
    "wind_speed_ms",
]


def main():
    df = pd.read_csv(INPUT_FILE)
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    df = df.sort_values("timestamp").reset_index(drop=True)

    # Flag the obvious PM10 placeholder without deleting other pollutants.
    df.loc[df["PM10 (µg/m³)"] >= 999, "PM10 (µg/m³)"] = float("nan")

    # Add time features in Bengaluru local time.
    local_time = df["timestamp"].dt.tz_convert("Asia/Kolkata")
    df["hour"] = local_time.dt.hour
    df["day_of_week"] = local_time.dt.dayofweek
    df["month"] = local_time.dt.month

    # Predict the PM2.5 value exactly one hour into the future.
    # Create a timestamp-to-PM2.5 lookup and fetch exactly t + 1 hour.
    pm25_by_time = df.set_index("timestamp")[TARGET_SOURCE]
    next_hour_timestamp = df["timestamp"] + pd.Timedelta(hours=1)
    df["target_pm25_next_hour"] = next_hour_timestamp.map(pm25_by_time)

    selected = [
        "timestamp",
        *FEATURES,
        "hour",
        "day_of_week",
        "month",
        "target_pm25_next_hour",
    ]
    model_df = df[selected].copy()

    # Remove rows without the current target or future target.
    model_df = model_df.dropna(
        subset=[TARGET_SOURCE, "target_pm25_next_hour"]
    )

    # Save data with remaining feature missingness visible for later handling.
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    model_df.to_csv(OUTPUT_FILE, index=False)

    print("PM2.5 modeling dataset created!")
    print(f"Rows: {len(model_df):,}")
    print(f"Columns: {len(model_df.columns)}")
    print(f"Saved to: {OUTPUT_FILE.relative_to(PROJECT_ROOT)}")
    print("\nMissing values per column:")
    print(model_df.isna().sum().to_string())
    print("\nFirst 5 rows:")
    print(model_df.head().to_string(index=False))


if __name__ == "__main__":
    main()
