from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import numpy as np

from .trips import Trip, get_accelerometers, get_gps_track, get_series


@dataclass(frozen=True)
class TripIcmResult:
    trip_id: str
    driver_id: str
    distance_km: float
    duration_s: float
    speeding_s: float
    harsh_accel_events: int
    harsh_brake_events: int
    harsh_turn_events: int
    icm_score: float

    def to_dict(self) -> dict:
        return {
            "tripId": self.trip_id,
            "driverId": self.driver_id,
            "distanceKm": self.distance_km,
            "durationSeconds": self.duration_s,
            "speedingSeconds": self.speeding_s,
            "harshAccelEvents": self.harsh_accel_events,
            "harshBrakeEvents": self.harsh_brake_events,
            "harshTurnEvents": self.harsh_turn_events,
            "icm": self.icm_score,
        }


def _driver_from_trip_id(trip_id: str) -> str:
    # trip id format is relative path with / replaced by | (frontend uses the same logic)
    if not trip_id:
        return ""
    return trip_id.split("|")[0] or ""


def _safe_float(x: Any) -> Optional[float]:
    try:
        n = float(x)
    except (TypeError, ValueError):
        return None
    return n if np.isfinite(n) else None


def _integrate_distance_km(t_s: np.ndarray, speed_kmh: np.ndarray) -> float:
    if t_s.size < 2:
        return 0.0
    dt = np.diff(t_s)
    dt = np.where(dt > 0, dt, 0.0)
    v0 = speed_kmh[:-1]
    v0 = np.where(np.isfinite(v0), v0, 0.0)
    dist_km = float(np.sum(v0 * dt) / 3600.0)
    return max(0.0, dist_km)


def _count_events_from_boolean(mask: np.ndarray) -> int:
    if mask.size == 0:
        return 0
    m = mask.astype(bool)
    # count rising edges
    rising = np.logical_and(m, np.logical_not(np.r_[False, m[:-1]]))
    return int(np.sum(rising))


def _speed_limit_kmh(trip: Trip) -> Optional[np.ndarray]:
    """Try to obtain per-sample speed limit from PROC_OPENSTREETMAP_DATA.

    Column mapping (excluding time):
    col1: current road maxspeed
    col2: reliability flag
    """

    try:
        series_maxspeed = get_series(trip, file_stem="PROC_OPENSTREETMAP_DATA", col=1)
        series_reliab = get_series(trip, file_stem="PROC_OPENSTREETMAP_DATA", col=2)
    except (FileNotFoundError, ValueError):
        return None

    maxspeed = np.asarray(series_maxspeed.v, dtype=float)
    reliab = np.asarray(series_reliab.v, dtype=float)

    # The series returned is aligned to its own timestamps; the consumer must align.
    # Here we just return the values and let the caller align by length if possible.
    if maxspeed.size == 0:
        return None

    # Keep only reliable entries if flag is usable; otherwise keep raw.
    if reliab.size == maxspeed.size:
        good = np.isfinite(reliab) & (reliab > 0)
        maxspeed = np.where(good, maxspeed, np.nan)

    return maxspeed


def compute_trip_icm(
    trip: Trip,
    *,
    speed_margin_kmh: float = 5.0,
    accel_threshold_g: float = 0.25,
    brake_threshold_g: float = 0.35,
    yaw_rate_threshold_dps: float = 18.0,
    default_speed_limit_kmh: float = 120.0,
) -> TripIcmResult:
    gps = get_gps_track(trip, downsample=1)
    t = np.asarray(gps.t, dtype=float)
    speed = np.asarray(gps.speed, dtype=float)

    duration_s = float(max(0.0, (t[-1] - t[0]) if t.size >= 2 else 0.0))
    distance_km = _integrate_distance_km(t, speed)

    # Speeding seconds
    speed_limit = None
    sl = _speed_limit_kmh(trip)
    # If OSM series length matches GPS length, treat as aligned. Otherwise fallback.
    if sl is not None and sl.size == speed.size:
        speed_limit = sl

    if speed_limit is None:
        speed_limit = np.full_like(speed, float(default_speed_limit_kmh))

    limit = np.asarray(speed_limit, dtype=float)
    limit = np.where(
        np.isfinite(limit) & (limit > 0), limit, float(default_speed_limit_kmh)
    )

    speeding_mask = np.isfinite(speed) & (speed > (limit + float(speed_margin_kmh)))
    if t.size >= 2:
        dt = np.diff(t)
        dt = np.where(dt > 0, dt, 0.0)
        speeding_s = float(np.sum(dt * speeding_mask[:-1]))
    else:
        speeding_s = 0.0

    # Harsh accel / brake from x_kf (Gs)
    try:
        ax = get_accelerometers(trip, axis="x_kf", downsample=1)
        ax_v = np.asarray(ax.v, dtype=float)
    except (FileNotFoundError, ValueError):
        ax_v = np.asarray([], dtype=float)

    harsh_accel_events = _count_events_from_boolean(
        np.isfinite(ax_v) & (ax_v >= float(accel_threshold_g))
    )
    harsh_brake_events = _count_events_from_boolean(
        np.isfinite(ax_v) & (ax_v <= -float(brake_threshold_g))
    )

    # Harsh turning from yaw rate (deg/s) using RAW_ACCELEROMETERS yaw (deg)
    try:
        yaw = get_accelerometers(trip, axis="yaw", downsample=1)
        yaw_t = np.asarray(yaw.t, dtype=float)
        yaw_v = np.asarray(yaw.v, dtype=float)
        if yaw_t.size >= 2:
            dy = np.diff(yaw_v)
            dt_y = np.diff(yaw_t)
            dt_y = np.where(dt_y > 0, dt_y, np.nan)
            yaw_rate = dy / dt_y
            harsh_turn_events = _count_events_from_boolean(
                np.isfinite(yaw_rate)
                & (np.abs(yaw_rate) >= float(yaw_rate_threshold_dps))
            )
        else:
            harsh_turn_events = 0
    except (FileNotFoundError, ValueError):
        harsh_turn_events = 0

    # ICM scoring: start at 100 and subtract progressively.
    # The design here penalizes rates, so trips of different duration/distance are comparable.
    hours = max(1e-6, duration_s / 3600.0)
    km = max(1e-6, distance_km)

    speeding_min = speeding_s / 60.0
    speeding_min_per_hour = speeding_min / hours

    harsh_accel_per_100km = harsh_accel_events / km * 100.0
    harsh_brake_per_100km = harsh_brake_events / km * 100.0
    harsh_turn_per_100km = harsh_turn_events / km * 100.0

    # Penalties (caps avoid going negative too aggressively)
    p_speed = min(45.0, 2.0 * speeding_min_per_hour)  # 2 points per min/hr speeding
    p_accel = min(20.0, 1.0 * harsh_accel_per_100km)
    p_brake = min(25.0, 1.2 * harsh_brake_per_100km)
    p_turn = min(20.0, 0.8 * harsh_turn_per_100km)

    score = 100.0 - (p_speed + p_accel + p_brake + p_turn)
    score = float(max(0.0, min(100.0, score)))

    return TripIcmResult(
        trip_id=trip.id,
        driver_id=_driver_from_trip_id(trip.id),
        distance_km=float(distance_km),
        duration_s=float(duration_s),
        speeding_s=float(speeding_s),
        harsh_accel_events=int(harsh_accel_events),
        harsh_brake_events=int(harsh_brake_events),
        harsh_turn_events=int(harsh_turn_events),
        icm_score=score,
    )


def aggregate_driver_scores(trip_results: List[TripIcmResult]) -> List[Dict[str, Any]]:
    by_driver: Dict[str, List[TripIcmResult]] = {}
    for r in trip_results:
        by_driver.setdefault(r.driver_id or "(unknown)", []).append(r)

    out: List[Dict[str, Any]] = []
    for driver_id, trips in sorted(by_driver.items(), key=lambda kv: kv[0]):
        total_km = float(sum(max(0.0, t.distance_km) for t in trips))
        if total_km > 0:
            icm = float(
                sum(t.icm_score * max(0.0, t.distance_km) for t in trips) / total_km
            )
        else:
            icm = float(sum(t.icm_score for t in trips) / max(1, len(trips)))

        out.append(
            {
                "driverId": driver_id,
                "icm": icm,
                "distanceKm": total_km,
                "trips": [t.to_dict() for t in sorted(trips, key=lambda x: x.trip_id)],
            }
        )

    # sort by best ICM desc by default
    out.sort(key=lambda d: (_safe_float(d.get("icm")) or 0.0), reverse=True)
    return out
