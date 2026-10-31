
from pathlib import Path

import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parent.parent
INPUT_FILE = PROJECT_ROOT / "data" / "processed" / "pm25_model_data.csv"
OUTPUT_DIR = PROJECT_ROOT / "data" / "processed"

def main():
    df = pd.read_csv(INPUT_FILE)
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    df = df.sort_values("timestamp").reset_index(drop=True)

    n = len(df)
    train_end = int(n * 0.70)
    validation_end = int(n * 0.85)

    train = df.iloc[:train_end].copy()
    validation = df.iloc[train_end:validation_end].copy()
    test = df.iloc[validation_end:].copy()

    train.to_csv(OUTPUT_DIR / "train.csv", index=False)
    validation.to_csv(OUTPUT_DIR / "validation.csv", index=False)
    test.to_csv(OUTPUT_DIR / "test.csv", index=False)

    print("Chronological split complete!")
    print(f"Total rows: {n:,}")
    print(f"Train rows: {len(train):,}")
    print(f"Validation rows: {len(validation):,}")
    print(f"Test rows: {len(test):,}")

    for name, part in [
        ("Train", train),
        ("Validation", validation),
        ("Test", test),
    ]:
        print(
            f"{name} range: {part['timestamp'].min()} to "
            f"{part['timestamp'].max()}"
        )

    print("\nSaved train.csv, validation.csv, and test.csv.")

if __name__ == "__main__":
    main()
