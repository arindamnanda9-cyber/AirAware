
from pathlib import Path

import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SOURCE_FILE = Path.home() / "Downloads" / "blr-btm-layout-cpcb-2024-25.csv"
OUTPUT_FILE = (
    PROJECT_ROOT / "data" / "processed" / "bangalore_cpcb_cleaned.csv"
)


def main():
    if not SOURCE_FILE.exists():
        raise FileNotFoundError(f"Dataset not found: {SOURCE_FILE}")

    print("Loading CPCB dataset...")
    df = pd.read_csv(SOURCE_FILE, low_memory=False)

    original_rows = len(df)

    # Parse source timestamps as UTC, then convert to Indian Standard Time.
    df["Timestamp"] = pd.to_datetime(
        df["Timestamp"], utc=True, errors="coerce"
    )

    invalid_timestamps = int(df["Timestamp"].isna().sum())
    df = df.dropna(subset=["Timestamp"]).copy()

    df["Timestamp"] = (
        df["Timestamp"].dt.tz_convert("Asia/Kolkata")
    )

    df = df.sort_values("Timestamp").reset_index(drop=True)

    # Keep the source measurements intact; only remove invalid timestamps.
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUTPUT_FILE, index=False)

    print("\nCleaning complete!")
    print(f"Original rows: {original_rows:,}")
    print(f"Rows removed for invalid timestamps: {invalid_timestamps:,}")
    print(f"Rows retained: {len(df):,}")
    print(f"Duplicate timestamps: {df['Timestamp'].duplicated().sum()}")
    print(f"First local timestamp: {df['Timestamp'].min()}")
    print(f"Last local timestamp: {df['Timestamp'].max()}")
    print(f"Saved to: {OUTPUT_FILE.relative_to(PROJECT_ROOT)}")


if __name__ == "__main__":
    main()
