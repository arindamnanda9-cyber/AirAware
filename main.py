import asyncio
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
import httpx
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
import joblib
from fastapi.middleware.cors import CORSMiddleware
from api.citywide import router as citywide_router
from api.citywide_expanded import router as citywide_expanded_router
from api.historical_aqi import router as historical_aqi_router
from api.routing import router as routing_router
from api.live_aqi import router as live_aqi_router

BASE_DIR = Path(__file__).resolve().parent
DATA_PATH = BASE_DIR / "data" / "processed" / "airaware_merged.csv"
MODEL_PATH = BASE_DIR / "models" / "saved" / "linear_regression_sklearn.joblib"

app = FastAPI(title="AirAware API", version="1.0.0")
app.include_router(citywide_router)
app.include_router(citywide_expanded_router)
app.include_router(historical_aqi_router)
app.include_router(routing_router)
app.include_router(live_aqi_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174", "http://127.0.0.1:5173", "http://127.0.0.1:4173"],
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
def get_gradient_descent(
    optimizer: str = Query(default="batch")
):
    import numpy as np

    model_files = {
        "batch": "linear_regression_scratch.npz",
        "sgd": "linear_regression_sgd.npz",
    }

    if optimizer not in model_files:
        raise HTTPException(
            status_code=400,
            detail="Invalid optimizer. Choose 'batch' or 'sgd'."
        )

    loss_path = BASE_DIR / "models" / "saved" / model_files[optimizer]

    if not loss_path.exists():
        raise HTTPException(
            status_code=503,
            detail=f"{optimizer.upper()} training history not found"
        )

    try:
        with np.load(loss_path) as saved:
            required = {"training_losses", "loss_checkpoint_epochs"}
            if not required.issubset(saved.files):
                raise HTTPException(
                    status_code=503,
                    detail="Training loss history is missing"
                )

            losses = saved["training_losses"].astype(float)
            epochs = saved["loss_checkpoint_epochs"].astype(int)

            if optimizer == "sgd":
                learning_rate = float(saved["learning_rate"])
                training_epochs = int(saved["training_epochs"])
                training_rows = int(saved["training_rows"])
                validation_rmse = float(saved["validation_rmse"])
                validation_mae = float(saved["validation_mae"])
            else:
                learning_rate = 0.01
                training_epochs = 2000
                training_rows = 10544
                validation_rmse = None
                validation_mae = None

        if (
            len(losses) == 0
            or len(losses) != len(epochs)
            or not np.isfinite(losses).all()
        ):
            raise HTTPException(
                status_code=503,
                detail="Training loss history is invalid"
            )

        result = {
            "model": "Linear Regression from scratch",
            "optimizer": (
                "Batch Gradient Descent"
                if optimizer == "batch"
                else "Stochastic Gradient Descent"
            ),
            "optimizer_key": optimizer,
            "loss_function": "Mean Squared Error",
            "learning_rate": learning_rate,
            "training_epochs": training_epochs,
            "training_rows": training_rows,
            "checkpoint_interval": (
                int(epochs[1] - epochs[0])
                if len(epochs) > 1 else training_epochs
            ),
            "initial_mse": round(float(losses[0]), 4),
            "final_recorded_mse": round(float(losses[-1]), 4),
            "loss_reduction_percent": round(
                (1 - float(losses[-1]) / float(losses[0])) * 100, 2
            ) if losses[0] != 0 else 0,
            "unit": "(µg/m³)²",
            "checkpoints": [
                {"epoch": int(epoch), "mse": round(float(loss), 4)}
                for epoch, loss in zip(epochs, losses)
            ],
            "data_type": "saved training history",
        }

        if validation_rmse is not None:
            result["validation_rmse"] = round(validation_rmse, 4)
            result["validation_mae"] = round(validation_mae, 4)

        return result

    except (OSError, ValueError, KeyError) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read training history: {exc}"
        )


OPEN_METEO_AQI_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
OPEN_METEO_WEATHER_URL = "https://api.open-meteo.com/v1/forecast"
OPEN_METEO_TIMEOUT = 15.0


@app.get("/api/predict/live")
async def predict_next_hour_live(
    latitude: float = Query(
        default=12.9716,
        ge=-90.0,
        le=90.0,
        description="Latitude of target location (default: 12.9716 for central Bengaluru)",
    ),
    longitude: float = Query(
        default=77.5946,
        ge=-180.0,
        le=180.0,
        description="Longitude of target location (default: 77.5946 for central Bengaluru)",
    ),
):
    """
    Predict next-hour PM2.5 concentration using current live air quality and weather
    from Open-Meteo applied to the trained Linear Regression model.
    """
    if model is None:
        raise HTTPException(
            status_code=503,
            detail="Trained Linear Regression prediction model is unavailable"
        )

    headers = {
        "User-Agent": "AirAware-Live-Prediction/1.0",
        "Accept": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=OPEN_METEO_TIMEOUT) as client:
            aq_task = client.get(
                OPEN_METEO_AQI_URL,
                params={
                    "latitude": latitude,
                    "longitude": longitude,
                    "current": "pm2_5",
                    "timezone": "Asia/Kolkata",
                },
                headers=headers,
            )
            weather_task = client.get(
                OPEN_METEO_WEATHER_URL,
                params={
                    "latitude": latitude,
                    "longitude": longitude,
                    "current": "temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m",
                    "wind_speed_unit": "ms",
                    "timezone": "Asia/Kolkata",
                },
                headers=headers,
            )
            aq_resp, weather_resp = await asyncio.gather(aq_task, weather_task)

    except httpx.TimeoutException:
        raise HTTPException(
            status_code=504,
            detail="Upstream weather or air quality service timed out."
        )
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to connect to upstream Open-Meteo services: {exc}"
        )

    if aq_resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Open-Meteo Air Quality service returned HTTP {aq_resp.status_code}: {aq_resp.text[:200]}"
        )
    if weather_resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Open-Meteo Weather service returned HTTP {weather_resp.status_code}: {weather_resp.text[:200]}"
        )

    aq_data = aq_resp.json()
    weather_data = weather_resp.json()

    aq_current = aq_data.get("current", {})
    weather_current = weather_data.get("current", {})

    current_pm25 = aq_current.get("pm2_5")
    if current_pm25 is None:
        raise HTTPException(
            status_code=502,
            detail="Current PM2.5 observation is unavailable from Open-Meteo air quality service."
        )

    temp_c = weather_current.get("temperature_2m")
    if temp_c is None:
        raise HTTPException(
            status_code=502,
            detail="Current temperature reading is unavailable from Open-Meteo weather service."
        )

    humidity_pct = weather_current.get("relative_humidity_2m")
    if humidity_pct is None:
        raise HTTPException(
            status_code=502,
            detail="Current relative humidity reading is unavailable from Open-Meteo weather service."
        )

    precip_mm = weather_current.get("precipitation")
    if precip_mm is None:
        raise HTTPException(
            status_code=502,
            detail="Current precipitation reading is unavailable from Open-Meteo weather service."
        )

    wind_speed = weather_current.get("wind_speed_10m")
    if wind_speed is None:
        raise HTTPException(
            status_code=502,
            detail="Current wind speed reading is unavailable from Open-Meteo weather service."
        )

    time_str = weather_current.get("time") or aq_current.get("time")
    kolkata_tz = ZoneInfo("Asia/Kolkata")
    if time_str:
        try:
            base_time = datetime.fromisoformat(time_str).replace(tzinfo=kolkata_tz)
        except (ValueError, TypeError):
            base_time = datetime.now(kolkata_tz)
    else:
        base_time = datetime.now(kolkata_tz)

    hour = base_time.hour
    day_of_week = base_time.weekday()
    month = base_time.month
    forecast_time = base_time + timedelta(hours=1)
    prediction_time = datetime.now(kolkata_tz)

    feature_dict = {
        "PM2.5 (µg/m³)": float(current_pm25),
        "temperature_c": float(temp_c),
        "relative_humidity_pct": float(humidity_pct),
        "precipitation_mm": float(precip_mm),
        "wind_speed_ms": float(wind_speed),
        "hour": int(hour),
        "day_of_week": int(day_of_week),
        "month": int(month),
    }

    input_df = pd.DataFrame([feature_dict], columns=FEATURES)
    if input_df.isna().any().any():
        missing = input_df.columns[input_df.isna().any()].tolist()
        raise HTTPException(
            status_code=502,
            detail=f"Required model features contain invalid/missing data: {missing}"
        )

    prediction_raw = float(model.predict(input_df)[0])
    predicted_pm25 = round(max(0.0, prediction_raw), 2)
    current_pm25_rounded = round(float(current_pm25), 2)
    delta_pm25 = round(predicted_pm25 - current_pm25_rounded, 2)

    return {
        "status": "success",
        "location": "Central Bengaluru",
        "coordinates": {
            "latitude": latitude,
            "longitude": longitude,
        },
        "current_pm25": current_pm25_rounded,
        "predicted_pm25": predicted_pm25,
        "delta_pm25": delta_pm25,
        "unit": "µg/m³",
        "prediction_target": "Next-hour ambient PM2.5 concentration",
        "current_timestamp": base_time.isoformat(),
        "forecast_timestamp": forecast_time.isoformat(),
        "prediction_timestamp": prediction_time.isoformat(),
        "model_name": "Linear Regression",
        "input_features": feature_dict,
        "data_sources": {
            "air_quality": "Open-Meteo Air Quality API (Copernicus CAMS & ECMWF atmospheric model)",
            "weather": "Open-Meteo Weather Forecast API",
            "model": "AirAware Linear Regression model trained on Bengaluru historical data",
        },
        "disclaimer": (
            "This next-hour PM2.5 forecast is a machine learning model prediction based on "
            "Open-Meteo atmospheric model estimates and weather inputs. It is NOT a direct "
            "physical measurement from CPCB or KSPCB ground monitoring stations."
        ),
        "is_live": True,
        "data_type": "model_prediction",
    }


@app.get("/api/predict")
def predict_next_hour():
    if model is None:
        raise HTTPException(status_code=503, detail="Saved prediction model not found")

    row = df.dropna(subset=["PM2.5 (µg/m³)"]).tail(1).copy()
    if row.empty:
        raise HTTPException(status_code=503, detail="No valid PM2.5 observations available")

    timestamp = row["timestamp"].iloc[0]
    local_time = timestamp.tz_convert("Asia/Kolkata")
    row["hour"] = local_time.hour
    row["day_of_week"] = local_time.day_of_week
    row["month"] = local_time.month

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
