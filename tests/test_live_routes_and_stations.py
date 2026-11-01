"""
Tests for live route pollution calculation and citywide live stations endpoint.
"""

from fastapi.testclient import TestClient
import pytest
from main import app


@pytest.fixture
def client():
    return TestClient(app)


def test_live_stations_aqi(client):
    """Verify GET /api/live-aqi/stations returns batched live estimates for citywide stations."""
    resp = client.get("/api/live-aqi/stations")
    assert resp.status_code == 200, resp.text
    data = resp.json()

    assert data["status"] == "success"
    assert data["is_live"] is True
    assert data["source"] == "Open-Meteo"
    assert "spatial_resolution_note" in data
    assert data["stations_count"] == 13
    assert len(data["stations"]) == 13

    # Check structure of station records
    sample = data["stations"][0]
    assert "station_id" in sample
    assert "name" in sample
    assert "latitude" in sample
    assert "longitude" in sample
    assert "model_grid_latitude" in sample
    assert "model_grid_longitude" in sample
    assert "pm2_5" in sample
    assert "us_aqi" in sample


def test_live_route_recommendation(client):
    """Verify POST /api/routes/recommend with mode='live' evaluates live exposure."""
    req_payload = {
        "origin_lat": 12.9716,
        "origin_lon": 77.5946,
        "destination_lat": 12.9166,
        "destination_lon": 77.6101,
        "departure_hour": 8,
        "departure_weekday": 0,
        "mode": "live",
    }
    resp = client.post("/api/routes/recommend", json=req_payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()

    assert data["is_live"] is True
    assert data["exposure_mode"] in ("live_atmospheric", "historical_fallback")
    assert len(data["routes"]) >= 1
    assert "calculation_methodology" in data
    assert "spatial_resolution_note" in data

    route = data["routes"][0]
    assert "estimated_mean_pm25" in route
    assert "estimated_cumulative_exposure" in route
    assert route["live_mean_pm25"] is not None
    assert len(route["sample_points"]) > 0


def test_historical_route_recommendation(client):
    """Verify POST /api/routes/recommend with mode='historical' evaluates CPCB IDW baseline."""
    req_payload = {
        "origin_lat": 12.9716,
        "origin_lon": 77.5946,
        "destination_lat": 12.9166,
        "destination_lon": 77.6101,
        "departure_hour": 8,
        "departure_weekday": 0,
        "mode": "historical",
    }
    resp = client.post("/api/routes/recommend", json=req_payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()

    assert data["is_live"] is False
    assert data["exposure_mode"] == "historical_estimate"
    assert len(data["routes"]) >= 1

    route = data["routes"][0]
    assert route["historical_mean_pm25"] is not None
