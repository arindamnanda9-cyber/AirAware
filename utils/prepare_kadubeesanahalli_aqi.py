"""Data ingestion and reshaping pipeline for Kadubeesanahalli Historical AQI.

Source: BWSSB Kadubeesanahalli CPCB Hourly AQI Data 2017–2023
Resource: d6bf24ed-cc61-4553-8578-4e259ac0e45d (OpenCity)

Converts wide-format monthly block CSV into standardized long format.
CRITICAL: AQI is an air quality index, NOT PM2.5 concentration. This data
must NEVER be fed into the PM2.5 prediction model or training pipeline.
"""

from __future__ import annotations

import argparse
import calendar
import csv
import math
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple


MONTH_MAP = {
    "January": 1,
    "February": 2,
    "March": 3,
    "April": 4,
    "May": 5,
    "June": 6,
    "July": 7,
    "August": 8,
    "September": 9,
    "October": 10,
    "November": 11,
    "December": 12,
}

STATION_ID = "bwssb_kadubeesanahalli"
TIMEZONE_STATUS = "unverified_source_local"

# Project-relative default paths
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INPUT_PATH = (
    PROJECT_ROOT
    / "data"
    / "external"
    / "kadubeesanahalli_aqi"
    / "kadubeesanahalli_aqi_2017_2023.csv"
)
FALLBACK_INPUT_PATH = Path.home() / "Downloads" / "3e154d19-cce0-4b3c-b38c-ce5eb0baf9da.csv"
DEFAULT_OUTPUT_PATH = (
    PROJECT_ROOT
    / "data"
    / "processed"
    / "aqi"
    / "kadubeesanahalli_aqi_processed.csv"
)


def get_default_input_path() -> Path:
    """Return project data path if exists, otherwise fallback to user downloads."""
    if DEFAULT_INPUT_PATH.exists():
        return DEFAULT_INPUT_PATH
    if FALLBACK_INPUT_PATH.exists():
        return FALLBACK_INPUT_PATH
    return DEFAULT_INPUT_PATH


def validate_calendar_date(year: int, month: int, day: int) -> Tuple[bool, Optional[str]]:
    """Validate calendar date using Python calendar, properly checking leap years.

    Returns:
        (is_valid, error_reason)
    """
    if month < 1 or month > 12:
        return False, f"Invalid month: {month} (must be 1–12)"

    try:
        max_days = calendar.monthrange(year, month)[1]
    except Exception as exc:
        return False, f"Calendar evaluation failed for year {year}, month {month}: {exc}"

    if day < 1 or day > max_days:
        leap_note = " (leap year)" if calendar.isleap(year) else " (non-leap year)"
        return (
            False,
            f"Invalid day: {day} for {calendar.month_name[month]} {year}{leap_note}. "
            f"Valid range is 1–{max_days}.",
        )

    return True, None


def parse_day_identifier(
    col0: str,
    current_year: Optional[int],
    current_month: Optional[int],
    previous_day: Optional[int],
    row_values: List[str],
    include_nov18: bool = True,
) -> Tuple[Optional[int], Optional[str]]:
    """Parse day identifier from column 0 with strict validation rules.

    Returns:
        (day_int, note_or_anomaly)
    """
    cleaned = col0.strip()

    # Standard integer day
    if cleaned.isdigit():
        return int(cleaned), None

    # Float representation (e.g., '1.0' in November 2017)
    if "." in cleaned:
        try:
            val = float(cleaned)
            if val.is_integer():
                return int(val), None
        except ValueError:
            pass

    # Explicit validated rule: November 2017 blank day immediately following day 17
    # Evidence: Row 294 in Nov 2017 immediately succeeds day 17 (row 293), precedes
    # Dec 2017 (row 296), has empty col0, and contains 7 valid consecutive hourly
    # readings (hours 00:00-06:00) followed by 17 missing values. Reconstructed as day 18.
    if cleaned == "":
        if (
            include_nov18
            and current_year == 2017
            and current_month == 11
            and previous_day == 17
            and any(cell.strip() for cell in row_values)
        ):
            return 18, "nov_2017_missing_day_imputed_day_18"
        return None, "empty_day_identifier_unmatched"

    return None, f"unrecognized_day_identifier: '{cleaned}'"


def validate_aqi_numeric_value(raw_val: str) -> Tuple[Optional[float], bool, bool, Optional[str]]:
    """Validate raw hourly AQI cell string.

    Returns:
        (numeric_val_or_none, is_missing, is_invalid, invalid_reason)
    """
    val_str = raw_val.strip()

    # Missing value representations
    if not val_str or val_str.lower() in ("nan", "null"):
        return None, True, False, None

    try:
        val = float(val_str)
    except ValueError:
        return None, False, True, f"Non-numeric string: '{val_str}'"

    # Reject non-finite values (inf, -inf)
    if not math.isfinite(val):
        return None, False, True, f"Non-finite numeric value: '{val_str}'"

    # Reject negative values
    if val < 0.0:
        return None, False, True, f"Negative AQI observation: {val}"

    return val, False, False, None


def parse_kadubeesanahalli_raw_csv(
    filepath: Path,
    include_nov18: bool = True,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Parse the raw wide CSV into long-format hourly records with strict validation.

    Args:
        filepath: Path to the raw CSV.
        include_nov18: Whether to apply the explicit rule for Nov 18, 2017.

    Returns:
        (records, audit_stats)
    """
    if not filepath.exists():
        raise FileNotFoundError(f"Source CSV not found: {filepath}")

    with filepath.open(mode="r", encoding="utf-8-sig") as file_handle:
        reader = csv.reader(file_handle)
        rows = list(reader)

    current_year: Optional[int] = None
    current_month: Optional[int] = None
    previous_day: Optional[int] = None

    hourly_records: List[Dict[str, Any]] = []
    structural_rows: List[Dict[str, Any]] = []
    anomalous_rows: List[Dict[str, Any]] = []
    invalid_readings: List[Dict[str, Any]] = []
    seen_daily_dates: Set[Tuple[int, int, int]] = set()

    daily_records_count = 0
    malformed_rows_count = 0
    valid_readings_count = 0
    missing_readings_count = 0
    invalid_readings_count = 0
    capped_500_count = 0
    min_aqi: Optional[float] = None
    max_aqi: Optional[float] = None

    for idx, row in enumerate(rows):
        if not row or not any(cell.strip() for cell in row):
            structural_rows.append({"index": idx, "type": "blank_separator"})
            continue

        col0 = row[0].strip()

        # Year header marker: ['Year', '2017']
        if col0 == "Year":
            try:
                current_year = int(row[1].strip())
            except (IndexError, ValueError) as exc:
                anomalous_rows.append({
                    "row_index": idx,
                    "type": "malformed_year_header",
                    "reason": str(exc),
                    "raw_row_preview": row[:5],
                })
                continue
            previous_day = None
            structural_rows.append({"index": idx, "type": "year_header", "year": current_year})
            continue

        # Strict Month Header Parsing: '<MonthName>-<YYYY>'
        if "-" in col0:
            parts = col0.split("-")
            if len(parts) == 2 and parts[0] in MONTH_MAP:
                month_name = parts[0]
                year_str = parts[1].strip()
                if year_str.isdigit() and len(year_str) == 4:
                    header_year = int(year_str)
                    header_month = MONTH_MAP[month_name]

                    # Validate year consistency if year marker was established
                    if current_year is not None and header_year != current_year:
                        anomalous_rows.append({
                            "row_index": idx,
                            "type": "month_header_year_mismatch",
                            "reason": (
                                f"Month header year {header_year} does not match "
                                f"active year marker {current_year}"
                            ),
                            "raw_row_preview": row[:5],
                        })
                        continue

                    # Validate month header column count (expected 25 columns)
                    if len(row) != 25:
                        anomalous_rows.append({
                            "row_index": idx,
                            "type": "malformed_month_header_columns",
                            "actual_columns": len(row),
                            "expected_columns": 25,
                            "reason": "Month header row does not contain 25 columns",
                            "raw_row_preview": row[:5],
                        })
                        continue

                    current_year = header_year
                    current_month = header_month
                    previous_day = None
                    structural_rows.append({
                        "index": idx,
                        "type": "month_header",
                        "month": current_month,
                        "year": current_year,
                        "label": col0,
                    })
                    continue
                else:
                    anomalous_rows.append({
                        "row_index": idx,
                        "type": "malformed_month_header",
                        "reason": f"Invalid year component in month header: '{col0}'",
                        "raw_row_preview": row[:5],
                    })
                    continue

        # Check for malformed month labels that don't match the strict pattern
        is_partial_month_match = any(col0.startswith(m) for m in MONTH_MAP)
        if is_partial_month_match:
            anomalous_rows.append({
                "row_index": idx,
                "type": "malformed_month_header",
                "reason": f"Label '{col0}' resembles a month but fails strict '<Month>-<YYYY>' format",
                "raw_row_preview": row[:5],
            })
            continue

        # Check calendar context availability
        if current_year is None or current_month is None:
            anomalous_rows.append({
                "row_index": idx,
                "type": "missing_calendar_context",
                "reason": "Encountered day row before valid year and month header were established",
                "raw_row_preview": row[:5],
            })
            continue

        # Parse day identifier
        day_val, note = parse_day_identifier(
            col0=col0,
            current_year=current_year,
            current_month=current_month,
            previous_day=previous_day,
            row_values=row[1:],
            include_nov18=include_nov18,
        )

        if day_val is None:
            anomalous_rows.append({
                "row_index": idx,
                "year": current_year,
                "month": current_month,
                "type": "unrecognized_day_identifier",
                "reason": note,
                "raw_row_preview": row[:5],
            })
            continue

        # November 2017 day-18 explicit recovery audit tracking
        if note == "nov_2017_missing_day_imputed_day_18":
            anomalous_rows.append({
                "row_index": idx,
                "year": current_year,
                "month": current_month,
                "day": day_val,
                "type": "nov_2017_missing_day_imputed",
                "reason": "November 2017 row immediately following day 17 (row 293)",
                "evidence": (
                    "Row 294 in November 2017 block immediately follows day 17 (17.0)"
                    " with valid hourly data for hours 00:00-06:00 and precedes"
                    " December 2017."
                ),
                "raw_row_preview": row[:5],
            })

        # Date Validation: Reject impossible dates & leap year checks
        is_valid_date, date_err = validate_calendar_date(current_year, current_month, day_val)
        if not is_valid_date:
            anomalous_rows.append({
                "row_index": idx,
                "year": current_year,
                "month": current_month,
                "day": day_val,
                "type": "impossible_calendar_date",
                "reason": date_err,
                "raw_row_preview": row[:5],
            })
            continue

        # Check for duplicate daily date
        date_key = (current_year, current_month, day_val)
        if date_key in seen_daily_dates:
            anomalous_rows.append({
                "row_index": idx,
                "year": current_year,
                "month": current_month,
                "day": day_val,
                "type": "duplicate_daily_date",
                "reason": f"Duplicate daily observation encountered for date {date_key}",
                "raw_row_preview": row[:5],
            })
            continue
        seen_daily_dates.add(date_key)

        # Source Row Validation: Daily row MUST contain exactly 25 columns
        if len(row) != 25:
            malformed_rows_count += 1
            anomalous_rows.append({
                "row_index": idx,
                "year": current_year,
                "month": current_month,
                "day": day_val,
                "type": "malformed_row_column_count",
                "actual_columns": len(row),
                "expected_columns": 25,
                "action": "skipped_row",
                "reason": f"Row has {len(row)} columns instead of expected 25; skipped hourly record generation",
                "raw_row_preview": row[:5],
            })
            continue

        previous_day = day_val
        daily_records_count += 1

        hour_cols = row[1:25]

        # Numeric Validation: Process each hourly observation
        for hour in range(24):
            raw_cell = hour_cols[hour]
            timestamp_str = f"{current_year:04d}-{current_month:02d}-{day_val:02d} {hour:02d}:00:00"

            val, is_missing, is_invalid, invalid_reason = validate_aqi_numeric_value(raw_cell)

            if is_invalid:
                invalid_readings_count += 1
                invalid_readings.append({
                    "row_index": idx,
                    "timestamp": timestamp_str,
                    "raw_value": raw_cell,
                    "reason": invalid_reason,
                })
                aqi_val = None
                is_capped = False
            elif is_missing:
                missing_readings_count += 1
                aqi_val = None
                is_capped = False
            else:
                valid_readings_count += 1
                aqi_val = val
                is_capped = (val == 500.0)
                if is_capped:
                    capped_500_count += 1

                if min_aqi is None or val < min_aqi:
                    min_aqi = val
                if max_aqi is None or val > max_aqi:
                    max_aqi = val

            hourly_records.append({
                "timestamp": timestamp_str,
                "aqi": aqi_val,
                "possible_upper_cap": is_capped,
                "station_id": STATION_ID,
                "timezone_status": TIMEZONE_STATUS,
            })

    audit_stats = {
        "total_source_lines": len(rows),
        "structural_rows_count": len(structural_rows),
        "anomalous_rows": anomalous_rows,
        "malformed_rows_count": malformed_rows_count,
        "invalid_readings": invalid_readings,
        "invalid_readings_count": invalid_readings_count,
        "daily_records_count": daily_records_count,
        "expected_hourly_slots": daily_records_count * 24,
        "total_hourly_records": len(hourly_records),
        "valid_readings": valid_readings_count,
        "missing_readings": missing_readings_count,
        "capped_500_readings": capped_500_count,
        "min_aqi": min_aqi,
        "max_aqi": max_aqi,
        "date_start": hourly_records[0]["timestamp"] if hourly_records else None,
        "date_end": hourly_records[-1]["timestamp"] if hourly_records else None,
        "duplicate_timestamps": len(hourly_records) - len(set(r["timestamp"] for r in hourly_records)),
    }

    return hourly_records, audit_stats


def save_processed_aqi_csv(records: List[Dict[str, Any]], output_path: Path) -> None:
    """Save long-format AQI records to CSV with null preservation."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = ["timestamp", "aqi", "possible_upper_cap", "station_id", "timezone_status"]

    with output_path.open(mode="w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in records:
            writer.writerow({
                "timestamp": r["timestamp"],
                "aqi": "" if r["aqi"] is None else r["aqi"],
                "possible_upper_cap": r["possible_upper_cap"],
                "station_id": r["station_id"],
                "timezone_status": r["timezone_status"],
            })


def main() -> None:
    parser = argparse.ArgumentParser(description="Process Kadubeesanahalli Historical AQI CSV.")
    parser.add_argument(
        "--input",
        type=Path,
        default=get_default_input_path(),
        help="Path to downloaded raw OpenCity CSV",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT_PATH,
        help="Path to save processed CSV",
    )
    parser.add_argument(
        "--exclude-nov18",
        action="store_true",
        help="Exclude November 18, 2017 to produce strict 2,494 daily record baseline",
    )
    args = parser.parse_args()

    include_nov18 = not args.exclude_nov18
    records, stats = parse_kadubeesanahalli_raw_csv(args.input, include_nov18=include_nov18)

    print("=== PROCESSING COMPLETE ===")
    print(f"Total Source Rows:       {stats['total_source_lines']}")
    print(f"Structural Rows:         {stats['structural_rows_count']}")
    print(f"Daily Records Extracted: {stats['daily_records_count']}")
    print(f"Malformed Rows Skipped:  {stats['malformed_rows_count']}")
    print(f"Hourly Slots Produced:   {stats['total_hourly_records']}")
    print(f"Valid Readings:          {stats['valid_readings']}")
    print(f"Missing Readings:        {stats['missing_readings']}")
    print(f"Invalid Readings:        {stats['invalid_readings_count']}")
    print(f"Capped 500 Readings:     {stats['capped_500_readings']}")
    print(f"Min AQI:                 {stats['min_aqi']}")
    print(f"Max AQI:                 {stats['max_aqi']}")
    print(f"Date Range:              {stats['date_start']} to {stats['date_end']}")
    print(f"Duplicate Timestamps:    {stats['duplicate_timestamps']}")
    print(f"Anomalous Rows Tracked:  {len(stats['anomalous_rows'])}")

    save_processed_aqi_csv(records, args.output)
    print(f"Saved processed dataset to: {args.output}")


if __name__ == "__main__":
    main()
