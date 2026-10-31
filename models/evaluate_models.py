from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data" / "processed"
MODEL_DIR = ROOT / "models" / "saved"

FEATURES = [
    "PM2.5 (µg/m³)",
    "temperature_c",
    "relative_humidity_pct",
    "precipitation_mm",
    "wind_speed_ms",
    "hour",
    "day_of_week",
    "month",
]

TARGET = "target_pm25_next_hour"


def calculate_metrics(actual, predicted):
    return {
        "RMSE": np.sqrt(mean_squared_error(actual, predicted)),
        "MAE": mean_absolute_error(actual, predicted),
        "R²": r2_score(actual, predicted),
    }


def main():
    test = pd.read_csv(DATA_DIR / "test.csv")
    X_test = test[FEATURES]
    y_test = test[TARGET]

    models = {
        "Persistence baseline": None,
        "Scikit-learn Linear Regression": "linear_regression_sklearn.joblib",
        "Random Forest": "random_forest.joblib",
    }

    results = []

    for name, filename in models.items():
        if filename is None:
            predictions = X_test["PM2.5 (µg/m³)"].to_numpy()
        else:
            model = joblib.load(MODEL_DIR / filename)
            predictions = model.predict(X_test)

        metrics = calculate_metrics(y_test, predictions)
        results.append({"Model": name, **metrics})

    results_df = pd.DataFrame(results).sort_values("RMSE")
    print("FINAL TEST RESULTS — AirAware")
    print(f"Test rows: {len(test):,}")
    print(results_df.to_string(index=False, float_format=lambda x: f"{x:.4f}"))

    output_path = ROOT / "reports"
    output_path.mkdir(parents=True, exist_ok=True)
    results_df.to_csv(output_path / "model_comparison.csv", index=False)
    print("\nSaved results to: reports/model_comparison.csv")


if __name__ == "__main__":
    main()