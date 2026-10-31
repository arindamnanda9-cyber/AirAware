from pathlib import Path

import joblib
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.pipeline import Pipeline

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


def main():
    train = pd.read_csv(DATA_DIR / "train.csv")
    validation = pd.read_csv(DATA_DIR / "validation.csv")

    X_train = train[FEATURES]
    y_train = train[TARGET]
    X_val = validation[FEATURES]
    y_val = validation[TARGET]

    model = Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("regressor", RandomForestRegressor(
            n_estimators=100,
            max_depth=12,
            min_samples_leaf=2,
            random_state=42,
            n_jobs=-1,
        )),
    ])

    print("Training Random Forest...")
    model.fit(X_train, y_train)
    predictions = model.predict(X_val)

    rmse = mean_squared_error(y_val, predictions) ** 0.5
    mae = mean_absolute_error(y_val, predictions)
    r2 = r2_score(y_val, predictions)

    print("\nRandom Forest — validation results")
    print(f"Training rows: {len(train):,}")
    print(f"Validation rows: {len(validation):,}")
    print(f"Validation RMSE: {rmse:.4f} µg/m³")
    print(f"Validation MAE: {mae:.4f} µg/m³")
    print(f"Validation R²: {r2:.4f}")

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    model_path = MODEL_DIR / "random_forest.joblib"
    joblib.dump(model, model_path)
    print(f"Saved model to: {model_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()