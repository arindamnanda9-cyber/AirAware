"""Automated tests for Kadubeesanahalli Historical AQI pipeline and API endpoints.

Covers:
- Wide-to-long conversion
- Date reconstruction & strict calendar validation
- Leap-year handling
- Duplicate daily dates detection
- Float day identifiers
- November 2017 anomaly handling & audit metadata
- Malformed short and long daily rows skipping and auditing
- Strict month header validation and invalid year context
- Missing values preservation (never 0)
- Numeric validation (finite, non-negative, rejecting inf/negative)
- AQI 500 preservation and possible_upper_cap flag
- Duplicate timestamps
- Date boundaries
- Summary counts (both baseline and with Nov 18 explicit rule)
- API responses (/station, /summary, /timeseries) with unverified_source_local timezone
- Existing PM2.5 model and data isolation
"""

import csv
import math
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
import pandas as pd

from main import app
from utils.prepare_kadubeesanahalli_aqi import (
    parse_day_identifier,
    parse_kadubeesanahalli_raw_csv,
    validate_calendar_date,
    validate_aqi_numeric_value,
    get_default_input_path,
    STATION_ID,
    TIMEZONE_STATUS,
)


RAW_CSV_PATH = get_default_input_path()
PROCESSED_CSV_PATH = Path(__file__).resolve().parent.parent / "data" / "processed" / "aqi" / "kadubeesanahalli_aqi_processed.csv"


@pytest.fixture(scope="session")
def client():
    return TestClient(app)


# 1. Day identifier parsing & Float handling
def test_float_day_identifiers():
    """Verify that float strings like '1.0' and '17.0' parse to integer days."""
    day, note = parse_day_identifier("1.0", 2017, 11, None, ["27", "27"])
    assert day == 1
    assert note is None

    day, note = parse_day_identifier("17.0", 2017, 11, 16, ["26", "33"])
    assert day == 17
    assert note is None

    day, note = parse_day_identifier("25", 2017, 5, 24, ["50", "45"])
    assert day == 25
    assert note is None


# 2. Strict Calendar Date Validation & Leap Year Handling
def test_calendar_date_validation_and_leap_years():
    """Verify calendar validation rejects impossible dates and respects leap years."""
    # Leap year: 2020 has 29 days in Feb
    valid_leap, err = validate_calendar_date(2020, 2, 29)
    assert valid_leap is True
    assert err is None

    # Non-leap year: 2021 has 28 days in Feb
    invalid_non_leap, err = validate_calendar_date(2021, 2, 29)
    assert invalid_non_leap is False
    assert "Invalid day: 29 for February 2021" in err

    # April has 30 days, not 31
    invalid_april, err = validate_calendar_date(2022, 4, 31)
    assert invalid_april is False
    assert "Invalid day: 31 for April" in err

    # Impossible days/months
    inv_month, err = validate_calendar_date(2022, 13, 1)
    assert inv_month is False
    assert "Invalid month" in err

    inv_zero_day, err = validate_calendar_date(2022, 5, 0)
    assert inv_zero_day is False


# 3. Numeric Validation (Finite, Non-Negative, Inf/Negative Rejection)
def test_numeric_validation_infinite_and_negative():
    """Verify rejection of inf, -inf, and negative numbers, and recognition of nulls."""
    # Finite valid numbers
    val, is_missing, is_invalid, reason = validate_aqi_numeric_value("50.5")
    assert val == 50.5
    assert is_missing is False
    assert is_invalid is False

    val, is_missing, is_invalid, reason = validate_aqi_numeric_value("0.0")
    assert val == 0.0
    assert is_invalid is False

    # Missing representations
    for empty_repr in ("", "   ", "null", "NULL", "nan", "NaN"):
        val, is_missing, is_invalid, reason = validate_aqi_numeric_value(empty_repr)
        assert val is None
        assert is_missing is True
        assert is_invalid is False

    # Infinite values
    val, is_missing, is_invalid, reason = validate_aqi_numeric_value("inf")
    assert is_invalid is True
    assert "Non-finite" in reason

    val, is_missing, is_invalid, reason = validate_aqi_numeric_value("-inf")
    assert is_invalid is True
    assert "Non-finite" in reason

    # Negative values
    val, is_missing, is_invalid, reason = validate_aqi_numeric_value("-12.4")
    assert is_invalid is True
    assert "Negative AQI observation" in reason

    # Non-numeric string
    val, is_missing, is_invalid, reason = validate_aqi_numeric_value("bad_data")
    assert is_invalid is True
    assert "Non-numeric" in reason


# 4. November 2017 anomaly explicit rule and audit metadata
def test_november_2017_anomaly_explicit_rule():
    """Verify explicit validated rule for November 2017 blank day identifier."""
    # Row matching exact conditions: 2017, Month 11, previous day 17, non-empty data
    day, note = parse_day_identifier(
        col0="",
        current_year=2017,
        current_month=11,
        previous_day=17,
        row_values=["39", "28", "29", "29.0"],
        include_nov18=True,
    )
    assert day == 18
    assert note == "nov_2017_missing_day_imputed_day_18"

    # Must NOT impute if previous day was not 17
    day_fail, note_fail = parse_day_identifier(
        col0="",
        current_year=2017,
        current_month=11,
        previous_day=10,
        row_values=["39", "28"],
        include_nov18=True,
    )
    assert day_fail is None
    assert note_fail == "empty_day_identifier_unmatched"

    # Must NOT impute if include_nov18 is disabled
    day_disabled, note_disabled = parse_day_identifier(
        col0="",
        current_year=2017,
        current_month=11,
        previous_day=17,
        row_values=["39", "28"],
        include_nov18=False,
    )
    assert day_disabled is None
    assert note_disabled == "empty_day_identifier_unmatched"


def test_november_2017_anomaly_audit_metadata():
    """Verify that November 2017 imputation records full audit metadata."""
    if not RAW_CSV_PATH.exists():
        pytest.skip("Raw CSV not present")

    _, stats = parse_kadubeesanahalli_raw_csv(RAW_CSV_PATH, include_nov18=True)
    nov_imputed = [
        item for item in stats["anomalous_rows"]
        if item.get("type") == "nov_2017_missing_day_imputed"
    ]
    assert len(nov_imputed) == 1
    record = nov_imputed[0]
    assert record["row_index"] == 294
    assert record["year"] == 2017
    assert record["month"] == 11
    assert record["day"] == 18
    assert "evidence" in record
    assert "raw_row_preview" in record
    assert record["raw_row_preview"][0] == ""


# 5. Malformed Short and Long Daily Rows Skipped and Audited
def test_malformed_short_and_long_daily_rows_skipped(tmp_path):
    """Verify malformed short (<25 cols) and long (>25 cols) rows are skipped and audited."""
    test_csv = tmp_path / "malformed_rows_test.csv"
    rows = [
        ["Year", "2020"],
        ["January-2020"] + [f"{h:02d}:00:00" for h in range(24)],
        # Valid row 1: exactly 25 columns
        ["1"] + ["50.0"] * 24,
        # Malformed short row 2: only 15 columns
        ["2"] + ["60.0"] * 14,
        # Malformed long row 3: 28 columns
        ["3"] + ["70.0"] * 27,
        # Valid row 4: exactly 25 columns
        ["4"] + ["80.0"] * 24,
    ]

    with test_csv.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerows(rows)

    records, stats = parse_kadubeesanahalli_raw_csv(test_csv)

    # Only the 2 valid rows must produce hourly records
    assert stats["daily_records_count"] == 2
    assert stats["total_hourly_records"] == 48
    assert stats["malformed_rows_count"] == 2
    assert stats["valid_readings"] == 48
    assert stats["missing_readings"] == 0

    # Verify both malformed rows are recorded in anomalous_rows with action: skipped_row
    malformed_anomalies = [
        a for a in stats["anomalous_rows"]
        if a.get("type") == "malformed_row_column_count"
    ]
    assert len(malformed_anomalies) == 2
    for anomaly in malformed_anomalies:
        assert anomaly["action"] == "skipped_row"
        assert anomaly["expected_columns"] == 25
        assert anomaly["actual_columns"] in (15, 28)

    # Ensure day 2 and day 3 timestamps were NOT generated
    generated_timestamps = [r["timestamp"] for r in records]
    assert any("2020-01-01" in ts for ts in generated_timestamps)
    assert not any("2020-01-02" in ts for ts in generated_timestamps)
    assert not any("2020-01-03" in ts for ts in generated_timestamps)
    assert any("2020-01-04" in ts for ts in generated_timestamps)


# 6. Strict Month Header Validation & Context Check
def test_strict_month_header_validation_and_context(tmp_path):
    """Verify strict month header parsing and prevention of silent context changes."""
    test_csv = tmp_path / "month_headers_test.csv"
    rows = [
        # Day row before any context: must be rejected
        ["1"] + ["50.0"] * 24,
        ["Year", "2020"],
        # Malformed month label without year: must be rejected
        ["January"] + [f"{h:02d}:00:00" for h in range(24)],
        # Malformed month label with non-digit year: must be rejected
        ["February-202X"] + [f"{h:02d}:00:00" for h in range(24)],
        # Month label with year mismatch: must be rejected
        ["March-2021"] + [f"{h:02d}:00:00" for h in range(24)],
        # Valid month header: exactly March-2020
        ["March-2020"] + [f"{h:02d}:00:00" for h in range(24)],
        # Valid day 1 in March 2020
        ["1"] + ["55.0"] * 24,
    ]

    with test_csv.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerows(rows)

    records, stats = parse_kadubeesanahalli_raw_csv(test_csv)

    anomaly_types = [a["type"] for a in stats["anomalous_rows"]]
    assert "missing_calendar_context" in anomaly_types
    assert "malformed_month_header" in anomaly_types
    assert "month_header_year_mismatch" in anomaly_types

    # Only the valid March 2020 day 1 row was processed
    assert stats["daily_records_count"] == 1
    assert stats["total_hourly_records"] == 24
    assert records[0]["timestamp"].startswith("2020-03-01")


# 7. Synthetic CSV Tests for Duplicate Dates & Invalid Numbers
def test_synthetic_csv_anomaly_detection(tmp_path):
    """Verify parser detects duplicate daily dates and invalid numbers."""
    synthetic_file = tmp_path / "synthetic_test.csv"
    rows = [
        ["Year", "2020"],
        ["February-2020"] + [f"{h:02d}:00:00" for h in range(24)],
        # Valid day 1
        ["1"] + ["40.0"] * 24,
        # Duplicate day 1
        ["1"] + ["42.0"] * 24,
        # Invalid date: Feb 30 in 2020
        ["30"] + ["50.0"] * 24,
        # Day 3 with invalid numbers: negative and inf
        ["3"] + ["-10.0", "inf"] + ["30.0"] * 22,
    ]

    with synthetic_file.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerows(rows)

    records, stats = parse_kadubeesanahalli_raw_csv(synthetic_file)

    anomaly_types = {item["type"] for item in stats["anomalous_rows"]}
    assert "duplicate_daily_date" in anomaly_types
    assert "impossible_calendar_date" in anomaly_types

    # Invalid numbers must be recorded in stats
    assert stats["invalid_readings_count"] == 2
    assert len(stats["invalid_readings"]) == 2
    assert any("Negative" in item["reason"] for item in stats["invalid_readings"])
    assert any("Non-finite" in item["reason"] for item in stats["invalid_readings"])


# 8. Missing values preserved as null (never zero)
def test_missing_values_preserved_as_null():
    """Verify missing readings remain null / NaN and are never converted to 0."""
    assert PROCESSED_CSV_PATH.exists(), "Processed dataset must exist"
    df = pd.read_csv(PROCESSED_CSV_PATH, keep_default_na=True)

    # Exactly 21,405 null values in aqi
    assert df["aqi"].isna().sum() == 21405

    # Check that nulls were not replaced with 0
    zero_count = (df["aqi"] == 0).sum()
    assert zero_count == 0, "No missing readings should be replaced with zero"


# 9. AQI 500 preservation and upper cap flagging
def test_aqi_500_preservation_and_flagging():
    """Verify that exactly 74 readings are 500 and flagged as possible_upper_cap."""
    df = pd.read_csv(PROCESSED_CSV_PATH)
    capped_rows = df[df["possible_upper_cap"] == True]
    assert len(capped_rows) == 74
    assert (capped_rows["aqi"] == 500.0).all()

    # Any reading < 500 must NOT be flagged
    uncapped = df[df["possible_upper_cap"] == False]
    valid_uncapped = uncapped["aqi"].dropna()
    assert (valid_uncapped < 500.0).all()


# 10. Duplicate timestamps and date boundaries
def test_no_duplicate_timestamps_and_date_boundaries():
    """Verify 0 duplicate timestamps and exact date bounds 2017-01-01 to 2023-12-31."""
    df = pd.read_csv(PROCESSED_CSV_PATH)
    assert df["timestamp"].is_unique, "Timestamps must be strictly unique"

    assert df["timestamp"].iloc[0] == "2017-01-01 00:00:00"
    assert df["timestamp"].iloc[-1] == "2023-12-31 23:00:00"


# 11. Timezone status in processed dataset
def test_processed_dataset_timezone_status():
    """Verify timezone_status is unverified_source_local across all records."""
    df = pd.read_csv(PROCESSED_CSV_PATH)
    assert (df["timezone_status"] == "unverified_source_local").all()


# 12. Exact counts verification (with and without Nov 18)
def test_summary_counts_verification():
    """Verify exact dataset numbers against audit findings."""
    if not RAW_CSV_PATH.exists():
        pytest.skip("Raw CSV not present for full audit replay test")

    # A. With explicit Nov 18 validated rule
    _, stats_imputed = parse_kadubeesanahalli_raw_csv(RAW_CSV_PATH, include_nov18=True)
    assert stats_imputed["total_source_lines"] == 2670
    assert stats_imputed["structural_rows_count"] == 175
    assert stats_imputed["daily_records_count"] == 2495
    assert stats_imputed["malformed_rows_count"] == 0
    assert stats_imputed["total_hourly_records"] == 59880
    assert stats_imputed["valid_readings"] == 38475
    assert stats_imputed["missing_readings"] == 21405
    assert stats_imputed["invalid_readings_count"] == 0
    assert stats_imputed["capped_500_readings"] == 74
    assert stats_imputed["min_aqi"] == 3.0
    assert stats_imputed["max_aqi"] == 500.0

    # B. Baseline without Nov 18 (unimputed baseline from initial audit)
    _, stats_baseline = parse_kadubeesanahalli_raw_csv(RAW_CSV_PATH, include_nov18=False)
    assert stats_baseline["daily_records_count"] == 2494
    assert stats_baseline["malformed_rows_count"] == 0
    assert stats_baseline["total_hourly_records"] == 59856
    assert stats_baseline["valid_readings"] == 38468
    assert stats_baseline["missing_readings"] == 21388
    assert stats_baseline["invalid_readings_count"] == 0
    assert stats_baseline["capped_500_readings"] == 74


# 13. API station metadata endpoint with unverified_source_local
def test_api_station_metadata(client):
    """Verify /api/historical-aqi/station returns unverified_source_local timezone status."""
    response = client.get("/api/historical-aqi/station")
    assert response.status_code == 200
    data = response.json()
    assert data["station_id"] == "bwssb_kadubeesanahalli"
    assert data["coordinate_status"] == "provisional"
    assert data["latitude"] == 12.9473
    assert data["longitude"] == 77.6983
    assert data["parameter"] == "AQI"
    assert data["timezone_status"] == "unverified_source_local"
    assert data["is_live"] is False
    assert "PM2.5" in data["note"]


# 14. API summary endpoint
def test_api_summary(client):
    """Verify /api/historical-aqi/summary returns completeness, counts, and isolation disclaimer."""
    response = client.get("/api/historical-aqi/summary")
    assert response.status_code == 200
    data = response.json()
    assert data["station_id"] == "bwssb_kadubeesanahalli"
    assert data["total_hourly_slots"] == 59880
    assert data["valid_readings"] == 38475
    assert data["missing_readings"] == 21405
    assert data["capped_500_readings"] == 74
    assert data["min_aqi"] == 3.0
    assert data["max_aqi"] == 500.0
    assert "model_isolation" in data

    # Test year filter
    resp_2018 = client.get("/api/historical-aqi/summary?year=2018")
    assert resp_2018.status_code == 200
    assert resp_2018.json()["filter_year"] == 2018


# 15. API timeseries endpoint with unverified_source_local & query filters
def test_api_timeseries(client):
    """Verify /api/historical-aqi/timeseries returns unverified_source_local timezone status."""
    response = client.get("/api/historical-aqi/timeseries?start_date=2017-01-01&end_date=2017-01-02&limit=48")
    assert response.status_code == 200
    data = response.json()
    assert data["returned_count"] == 48
    assert len(data["readings"]) == 48
    assert data["readings"][0]["timestamp"] == "2017-01-01 00:00:00"
    assert data["timezone_status"] == "unverified_source_local"

    # Test include_missing=false
    resp_no_missing = client.get("/api/historical-aqi/timeseries?include_missing=false&limit=10")
    assert resp_no_missing.status_code == 200
    for r in resp_no_missing.json()["readings"]:
        assert r["aqi"] is not None


def test_api_timeseries_year_month_filtering(client):
    """Verify year, month, combined, and pagination filtering on /timeseries."""
    # 1. December 2023 filtering
    resp_dec23 = client.get("/api/historical-aqi/timeseries?year=2023&month=12&limit=1000")
    assert resp_dec23.status_code == 200
    data_dec23 = resp_dec23.json()
    assert data_dec23["total_matched"] == 744  # 31 days * 24 hours
    assert all(r["timestamp"].startswith("2023-12-") for r in data_dec23["readings"])

    # 2. January 2017 filtering (incomplete month: 23 days * 24 hours = 552)
    resp_jan17 = client.get("/api/historical-aqi/timeseries?year=2017&month=1&limit=1000")
    assert resp_jan17.status_code == 200
    data_jan17 = resp_jan17.json()
    assert data_jan17["total_matched"] == 552
    assert all(r["timestamp"].startswith("2017-01-") for r in data_jan17["readings"])

    # 3. Year-only filtering (2020 leap year: 366 days * 24 hrs = 8784)
    resp_2020 = client.get("/api/historical-aqi/timeseries?year=2020&limit=10")
    assert resp_2020.status_code == 200
    data_2020 = resp_2020.json()
    assert data_2020["total_matched"] == 8784
    assert all(r["timestamp"].startswith("2020-") for r in data_2020["readings"])

    # 4. Month-only filtering (June across 7 years 2017-2023: 209 days * 24 hrs = 5016)
    resp_june = client.get("/api/historical-aqi/timeseries?month=6&limit=10")
    assert resp_june.status_code == 200
    data_june = resp_june.json()
    assert data_june["total_matched"] == 5016
    assert all("-06-" in r["timestamp"] for r in data_june["readings"])

    # 5. Combined date-range and year/month filters
    resp_comb = client.get(
        "/api/historical-aqi/timeseries?year=2023&month=12&start_date=2023-12-10&end_date=2023-12-12&limit=100"
    )
    assert resp_comb.status_code == 200
    data_comb = resp_comb.json()
    assert data_comb["total_matched"] == 72  # 3 days * 24 hours = 72
    assert data_comb["readings"][0]["timestamp"] == "2023-12-10 00:00:00"
    assert data_comb["readings"][-1]["timestamp"] == "2023-12-12 23:00:00"

    # 6. Pagination after filtering
    resp_page = client.get("/api/historical-aqi/timeseries?year=2023&month=12&limit=10&offset=5")
    assert resp_page.status_code == 200
    data_page = resp_page.json()
    assert data_page["total_matched"] == 744
    assert data_page["limit"] == 10
    assert data_page["offset"] == 5
    assert data_page["returned_count"] == 10
    assert data_page["readings"][0]["timestamp"] == "2023-12-01 05:00:00"

    # 7. Missing observations retained when include_missing=true
    resp_missing = client.get("/api/historical-aqi/timeseries?year=2023&month=12&limit=100&include_missing=true")
    assert resp_missing.status_code == 200
    assert any(r["aqi"] is None for r in resp_missing.json()["readings"])

    # 8. Filter producing no records returns total_matched=0 and empty readings list
    resp_empty = client.get(
        "/api/historical-aqi/timeseries?year=2023&month=12&start_date=2023-11-01&end_date=2023-11-05"
    )
    assert resp_empty.status_code == 200
    data_empty = resp_empty.json()
    assert data_empty["total_matched"] == 0
    assert data_empty["returned_count"] == 0
    assert data_empty["readings"] == []

    # 9. Query validation: reject invalid year/month with 422
    assert client.get("/api/historical-aqi/timeseries?year=2025").status_code == 422
    assert client.get("/api/historical-aqi/timeseries?year=2016").status_code == 422
    assert client.get("/api/historical-aqi/timeseries?month=13").status_code == 422
    assert client.get("/api/historical-aqi/timeseries?month=0").status_code == 422


# 16. Existing PM2.5 pipeline isolation
def test_pm25_pipeline_isolation(client):
    """Verify existing PM2.5 model and endpoints are completely unaffected."""
    # Existing prediction endpoint
    pred_resp = client.get("/api/predict")
    assert pred_resp.status_code == 200
    assert "predicted_pm25" in pred_resp.json()
    assert pred_resp.json()["location"] == "BTM Layout, Bengaluru"

    # Existing historical endpoint
    hist_resp = client.get("/api/history?limit=5")
    assert hist_resp.status_code == 200
    assert "data" in hist_resp.json()

    # Existing citywide stations endpoint
    cw_resp = client.get("/api/citywide/stations")
    assert cw_resp.status_code == 200
    assert len(cw_resp.json()["stations"]) == 3

    # Expanded citywide stations endpoint
    cw_exp_resp = client.get("/api/citywide-expanded/stations")
    assert cw_exp_resp.status_code == 200
    assert len(cw_exp_resp.json()["stations"]) == 13
