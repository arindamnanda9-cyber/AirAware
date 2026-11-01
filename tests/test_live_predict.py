"""
Tests for live next-hour PM2.5 prediction endpoint (/api/predict/live).
"""

from unittest.mock import AsyncMock, patch
import httpx
import pytest
from fastapi.testclient import TestClient

from main import app, FEATURES


@pytest.fixture
def client():
    return TestClient(app)


def test_predict_live_success(client):
    """Verify GET /api/predict/live returns all required fields and valid prediction."""
    resp = client.get("/api/predict/live")
    assert resp.status_code == 200, resp.text
    data = resp.json()

    assert data["status"] == "success"
    assert "current_pm25" in data
    assert "predicted_pm25" in data
    assert data["unit"] == "µg/m³"
    assert data["model_name"] == "Linear Regression"
    assert "prediction_timestamp" in data
    assert "forecast_timestamp" in data
    assert "data_sources" in data
    assert "disclaimer" in data
    assert data["is_live"] is True
    assert data["data_type"] == "model_prediction"

    # Verify input features contains all eight training features in exact order
    input_features = data["input_features"]
    for feature in FEATURES:
        assert feature in input_features
        assert input_features[feature] is not None

    assert isinstance(data["current_pm25"], (int, float))
    assert isinstance(data["predicted_pm25"], (int, float))
    assert data["predicted_pm25"] >= 0.0


def test_predict_live_missing_feature_raises_502(client):
    """Verify that if an upstream feature (e.g. wind speed) is missing, 502 is returned."""
    mock_aq_resp = httpx.Response(
        status_code=200,
        json={"current": {"time": "2026-11-01T14:00", "pm2_5": 25.0}},
        request=httpx.Request("GET", "https://air-quality-api.open-meteo.com/v1/air-quality"),
    )
    mock_weather_resp = httpx.Response(
        status_code=200,
        json={
            "current": {
                "time": "2026-11-01T14:00",
                "temperature_2m": 28.0,
                "relative_humidity_2m": 50,
                "precipitation": 0.0,
                "wind_speed_10m": None,  # Missing wind speed
            }
        },
        request=httpx.Request("GET", "https://api.open-meteo.com/v1/forecast"),
    )

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.side_effect = [mock_aq_resp, mock_weather_resp]
        resp = client.get("/api/predict/live")
        assert resp.status_code == 502
        assert "wind speed" in resp.json()["detail"].lower()


def test_predict_live_timeout_raises_504(client):
    """Verify that timeout raises 504 Gateway Timeout."""
    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.side_effect = httpx.TimeoutException("Connection timed out")
        resp = client.get("/api/predict/live")
        assert resp.status_code == 504
        assert "timed out" in resp.json()["detail"].lower()


def test_historical_predict_isolation(client):
    """Verify that existing historical /api/predict is completely unchanged."""
    resp = client.get("/api/predict")
    assert resp.status_code == 200
    data = resp.json()
    assert data["location"] == "BTM Layout, Bengaluru"
    assert "predicted_pm25" in data
    assert data["model"] == "Linear Regression"
    assert "data_type" in data
    assert "historical" in data["data_type"]
