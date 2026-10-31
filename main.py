from pathlib import Path
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
import joblib
from fastapi.middleware.cors import CORSMiddleware
from api.citywide import router as citywide_router
from api.citywide_expanded import router as citywide_expanded_router

BASE_DIR = Path(__file__).resolve().parent
DATA_PATH = BASE_DIR / "data" / "processed" / "airaware_merged.csv"
MODEL_PATH = BASE_DIR / "models" / "saved" / "linear_regression_sklearn.joblib"

app = FastAPI(title="AirAware API", version="1.0.0")
app.include_router(citywide_router)
app.include_router(citywide_expanded_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174", "http://127.0.0.1:4173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def load_data():
    if not DATA_PATH.exists():
        raise RuntimeError(f"Dataset not found: {DATA_PATH}")
    data = pd.read_csv(DATA_PATH)
    data["timestamp"] = pd.to_datetime(data["timestamp"], utc=True)
    return data.sort_values("timestamp").reset_index(drop=True)

df = load_data()

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

model = joblib.load(MODEL_PATH) if MODEL_PATH.exists() else None


@app.get("/")
def root():
    return {"name": "AirAware API", "status": "running", "dataset_rows": len(df)}

@app.get("/api/summary")
def get_summary():
    pm25 = pd.to_numeric(df["PM2.5 (µg/m³)"], errors="coerce").dropna()
    if pm25.empty:
        raise HTTPException(status_code=503, detail="No PM2.5 observations available")
    return {
        "location": "BTM Layout, Bengaluru",
        "records": len(df),
        "pm25_valid_records": int(pm25.count()),
        "pm25_mean": round(float(pm25.mean()), 2),
        "pm25_median": round(float(pm25.median()), 2),
        "pm25_max": round(float(pm25.max()), 2),
        "first_timestamp": df["timestamp"].min().isoformat(),
        "last_timestamp": df["timestamp"].max().isoformat(),
        "data_type": "historical observations",
    }

@app.get("/api/history")
def get_history(
    limit: int = Query(default=168, ge=1, le=2000),
    start_date: str | None = Query(default=None, description="Start date, YYYY-MM-DD"),
    end_date: str | None = Query(default=None, description="End date, YYYY-MM-DD"),
):
    filtered = df.copy()

    try:
        if start_date:
            start = pd.to_datetime(start_date, errors="raise", utc=True)
            filtered = filtered[filtered["timestamp"] >= start]
        if end_date:
            end = pd.to_datetime(end_date, errors="raise", utc=True) + pd.Timedelta(days=1)
            filtered = filtered[filtered["timestamp"] < end]
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Dates must use YYYY-MM-DD format")

    # With no date range, preserve the existing behavior: return the latest records.
    if not start_date and not end_date:
        filtered = filtered.tail(limit)
    else:
        filtered = filtered.tail(limit)

    history = filtered[["timestamp", "PM2.5 (µg/m³)", "PM10 (µg/m³)"]].copy()
    history = history.rename(columns={"PM2.5 (µg/m³)": "pm25", "PM10 (µg/m³)": "pm10"})
    history["timestamp"] = history["timestamp"].dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    history = history.astype(object).where(pd.notna(history), None)
    return {
        "count": len(history),
        "unit": "µg/m³",
        "start_date": start_date,
        "end_date": end_date,
        "timezone": "UTC",
        "data": history.to_dict(orient="records"),
    }


@app.get("/api/gradient-descent")
def get_gradient_descent():
    loss_path = BASE_DIR / "models" / "saved" / "linear_regression_scratch.npz"

    if not loss_path.exists():
        raise HTTPException(status_code=503, detail="Gradient descent training data not found")

    import numpy as np

    try:
        with np.load(loss_path) as saved:
            if "training_losses" not in saved or "loss_checkpoint_epochs" not in saved:
                raise HTTPException(status_code=503, detail="Training loss history is missing")

            losses = saved["training_losses"].astype(float)
            epochs = saved["loss_checkpoint_epochs"].astype(int)

        if len(losses) == 0 or len(losses) != len(epochs):
            raise HTTPException(status_code=503, detail="Training loss history is invalid")

        return {
            "model": "Linear Regression from scratch",
            "optimizer": "Batch Gradient Descent",
            "loss_function": "Mean Squared Error",
            "learning_rate": 0.01,
            "training_epochs": 2000,
            "training_rows": 10544,
            "checkpoint_interval": 100,
            "initial_mse": round(float(losses[0]), 4),
            "final_recorded_mse": round(float(losses[-1]), 4),
            "loss_reduction_percent": round(
                (1 - float(losses[-1]) / float(losses[0])) * 100, 2
            ),
            "unit": "(µg/m³)²",
            "checkpoints": [
                {"epoch": int(epoch), "mse": round(float(loss), 4)}
                for epoch, loss in zip(epochs, losses)
            ],
            "data_type": "saved training history",
        }
    except (OSError, ValueError, KeyError) as exc:
        raise HTTPException(status_code=500, detail=f"Could not read training history: {exc}")


@app.get("/api/predict")
def predict_next_hour():
    if model is None:
        raise HTTPException(status_code=503, detail="Saved prediction model not found")

    row = df.dropna(subset=["PM2.5 (µg/m³)"]).tail(1).copy()
    if row.empty:
        raise HTTPException(status_code=503, detail="No valid PM2.5 observations available")

    timestamp = row["timestamp"].iloc[0]
    row["hour"] = timestamp.hour
    row["day_of_week"] = timestamp.dayofweek
    row["month"] = timestamp.month

    features = row.reindex(columns=FEATURES)
    prediction = float(model.predict(features)[0])

    return {
        "location": "BTM Layout, Bengaluru",
        "prediction_target": "next hour after the latest available observation",
        "based_on_timestamp": timestamp.isoformat(),
        "forecast_timestamp": (timestamp + pd.Timedelta(hours=1)).isoformat(),
        "input_pm25": float(row["PM2.5 (µg/m³)"].iloc[0]),
        "predicted_pm25": round(max(0.0, prediction), 2),
        "unit": "µg/m³",
        "data_type": "historical-model estimate, not a current forecast",
        "model": "Linear Regression",
        "warning": "Historical data ends on 2025-12-31. This estimate is not a prediction of current air quality."
    }
