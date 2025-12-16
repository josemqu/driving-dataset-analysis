from __future__ import annotations

import os
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .icm import aggregate_driver_scores, compute_trip_icm
from .trips import (
    AccelAxis,
    TripIndex,
    build_trip_index,
    get_accelerometers,
    get_available_series_files,
    get_events,
    get_gps_track,
    get_series,
    get_table,
)


APP_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIR = APP_ROOT / "frontend"

DATASET_ROOT = Path(
    os.environ.get(
        "UAH_DATASET_ROOT",
        str((APP_ROOT / "data").resolve()),
    )
)

app = FastAPI(title="UAH DriveSet Web Viewer")

_trip_index: TripIndex | None = None


def trip_index() -> TripIndex:
    global _trip_index
    if _trip_index is None:
        _trip_index = build_trip_index(DATASET_ROOT)
    return _trip_index


@app.get("/api/trips")
def list_trips() -> dict:
    idx = trip_index()
    return {
        "datasetRoot": str(DATASET_ROOT),
        "trips": [t.to_dict() for t in idx.trips],
    }


@app.get("/api/trips/{trip_id}/video")
def get_trip_video(trip_id: str):
    idx = trip_index()
    trip = idx.by_id.get(trip_id)
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")
    if trip.video_path is None or not trip.video_path.exists():
        raise HTTPException(status_code=404, detail="Video not found")
    return FileResponse(str(trip.video_path))


@app.get("/api/trips/{trip_id}/accelerometers")
def get_trip_accelerometers(
    trip_id: str,
    axis: AccelAxis = Query(default="x"),
    downsample: int = Query(default=1, ge=1, le=1000),
):
    idx = trip_index()
    trip = idx.by_id.get(trip_id)
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")

    data = get_accelerometers(trip, axis=axis, downsample=downsample)
    return {
        "tripId": trip.id,
        "axis": axis,
        "offsetSeconds": trip.offset_seconds,
        "t": data.t.tolist(),
        "v": data.v.tolist(),
    }


@app.get("/api/trips/{trip_id}/series")
def get_trip_series(
    trip_id: str,
    file: str = Query(..., min_length=1),
    col: int = Query(..., ge=1),
    downsample: int = Query(default=1, ge=1, le=1000),
):
    idx = trip_index()
    trip = idx.by_id.get(trip_id)
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")

    try:
        data = get_series(trip, file_stem=file, col=col, downsample=downsample)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    return {
        "tripId": trip.id,
        "file": file,
        "col": col,
        "offsetSeconds": trip.offset_seconds,
        "t": data.t.tolist(),
        "v": data.v.tolist(),
    }


@app.get("/api/trips/{trip_id}/series_files")
def get_trip_series_files(trip_id: str) -> dict:
    idx = trip_index()
    trip = idx.by_id.get(trip_id)
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")

    return {
        "tripId": trip.id,
        "files": get_available_series_files(trip),
    }


@app.get("/api/trips/{trip_id}/gps")
def get_trip_gps(
    trip_id: str,
    downsample: int = Query(default=1, ge=1, le=1000),
):
    idx = trip_index()
    trip = idx.by_id.get(trip_id)
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")

    try:
        gps = get_gps_track(trip, downsample=downsample)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e

    return {
        "tripId": trip.id,
        "offsetSeconds": trip.offset_seconds,
        "t": gps.t.tolist(),
        "lat": gps.lat.tolist(),
        "lon": gps.lon.tolist(),
        "speed": gps.speed.tolist(),
    }


@app.get("/api/trips/{trip_id}/table")
def get_trip_table(
    trip_id: str,
    file: str = Query(..., min_length=1),
    downsample: int = Query(default=1, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=2000),
):
    idx = trip_index()
    trip = idx.by_id.get(trip_id)
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")

    try:
        columns, rows, total = get_table(
            trip,
            file_stem=file,
            downsample=downsample,
            offset=offset,
            limit=limit,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    return {
        "tripId": trip.id,
        "file": file,
        "offsetSeconds": trip.offset_seconds,
        "downsample": downsample,
        "offset": offset,
        "limit": limit,
        "total": total,
        "columns": columns,
        "rows": rows.tolist(),
    }


@app.get("/api/trips/{trip_id}/events")
def get_trip_events(
    trip_id: str,
    filePrefix: str = Query(default="EVENTS_LIST_LANE_CHANGES"),
) -> dict:
    idx = trip_index()
    trip = idx.by_id.get(trip_id)
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")

    events = get_events(trip, file_prefix=filePrefix or None)
    return {
        "tripId": trip.id,
        "offsetSeconds": trip.offset_seconds,
        "filePrefix": filePrefix,
        "events": events,
    }


@app.get("/api/trips/{trip_id}/evidence")
def get_trip_evidence(
    trip_id: str,
    kind: str = Query(..., min_length=1),
    only_events: bool = Query(default=False),
    speed_margin_kmh: float = Query(default=5.0, ge=0.0, le=50.0),
    accel_threshold_g: float = Query(default=0.25, ge=0.0, le=5.0),
    brake_threshold_g: float = Query(default=0.35, ge=0.0, le=5.0),
    yaw_rate_threshold_dps: float = Query(default=18.0, ge=0.0, le=500.0),
    default_speed_limit_kmh: float = Query(default=120.0, ge=10.0, le=200.0),
    max_rows: int = Query(default=0, ge=0, le=200000),
) -> dict:
    idx = trip_index()
    trip = idx.by_id.get(trip_id)
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")

    k = kind.strip().lower()

    def _clip(arr: np.ndarray) -> np.ndarray:
        if max_rows == 0:
            return arr
        if arr.shape[0] <= max_rows:
            return arr
        return arr[:max_rows]

    def _maybe_filter(
        t_: np.ndarray, data_cols: list[np.ndarray], mask: np.ndarray
    ) -> tuple[np.ndarray, list[np.ndarray], np.ndarray]:
        if not only_events:
            return t_, data_cols, mask
        idx = np.where(mask.astype(bool))[0]
        if idx.size == 0:
            return t_[:0], [c[:0] for c in data_cols], mask[:0]
        return t_[idx], [c[idx] for c in data_cols], mask[idx]

    def _rows(
        t_: np.ndarray,
        columns: list[str],
        data_cols: list[np.ndarray],
        mask: np.ndarray,
    ) -> dict:
        t_ = np.asarray(t_, dtype=float)
        data_cols = [np.asarray(c, dtype=float) for c in data_cols]
        mask = np.asarray(mask, dtype=bool)

        # Filter first (so events are not lost by clipping the beginning)
        t_, data_cols, mask = _maybe_filter(t_, data_cols, mask)

        t_ = _clip(t_)
        data_cols = [_clip(c) for c in data_cols]
        mask = _clip(mask)

        n = int(min([t_.shape[0], mask.shape[0], *[c.shape[0] for c in data_cols]]))

        rows = []
        for i in range(n):
            rows.append(
                [float(t_[i]), *[float(col[i]) for col in data_cols], bool(mask[i])]
            )
        return {"columns": columns + ["isEvent"], "rows": rows}

    if k == "speeding":
        # Load GPS only for speeding evidence
        try:
            gps = get_gps_track(trip, downsample=1)
        except FileNotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e

        t = _clip(np.asarray(gps.t, dtype=float))
        speed = _clip(np.asarray(gps.speed, dtype=float))

        # Use OSM speed limit if aligned; else default.
        speed_limit = None
        try:
            sl = get_series(trip, file_stem="PROC_OPENSTREETMAP_DATA", col=1)
            rl = get_series(trip, file_stem="PROC_OPENSTREETMAP_DATA", col=2)
            if sl.v.shape[0] == gps.speed.shape[0]:
                limit = sl.v.astype(float)
                if rl.v.shape[0] == limit.shape[0]:
                    good = (rl.v.astype(float) > 0) & (np.isfinite(rl.v.astype(float)))
                    limit = np.where(good, limit, np.nan)
                speed_limit = limit
        except (FileNotFoundError, ValueError):
            speed_limit = None

        if speed_limit is None:
            speed_limit = np.full_like(
                gps.speed, float(default_speed_limit_kmh), dtype=float
            )

        speed_limit = _clip(np.asarray(speed_limit, dtype=float))
        limit = np.where(
            np.isfinite(speed_limit) & (speed_limit > 0),
            speed_limit,
            float(default_speed_limit_kmh),
        )
        mask = (np.isfinite(speed)) & (speed > (limit + float(speed_margin_kmh)))

        payload = _rows(
            t,
            ["t", "speedKmh", "limitKmh"],
            [speed, limit],
            mask,
        )
        return {
            "tripId": trip.id,
            "kind": "speeding",
            "offsetSeconds": trip.offset_seconds,
            "stats": {
                "totalSamples": int(mask.shape[0]),
                "eventSamples": int(np.sum(mask.astype(int))),
                "onlyEvents": bool(only_events),
                "maxRows": int(max_rows),
                "speedMarginKmh": float(speed_margin_kmh),
                "maxSpeedKmh": float(np.nanmax(speed)) if speed.size else 0.0,
            },
            **payload,
        }

    if k in ("harsh_accel", "harsh_brake"):
        try:
            ax = get_accelerometers(trip, axis="x_kf", downsample=1)
        except FileNotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e

        ax_t = np.asarray(ax.t, dtype=float)
        ax_v = np.asarray(ax.v, dtype=float)
        if k == "harsh_accel":
            exceed = np.isfinite(ax_v) & (ax_v >= float(accel_threshold_g))
        else:
            exceed = np.isfinite(ax_v) & (ax_v <= -float(brake_threshold_g))

        # Mark only event starts (rising edges) to match ICM event counting.
        mask = exceed & np.logical_not(np.r_[False, exceed[:-1]])

        payload = _rows(
            ax_t,
            ["t", "axG"],
            [ax_v],
            mask,
        )
        return {
            "tripId": trip.id,
            "kind": k,
            "offsetSeconds": trip.offset_seconds,
            "stats": {
                "totalSamples": int(mask.shape[0]),
                "exceedSamples": int(np.sum(exceed.astype(int))),
                "eventEdges": int(np.sum(mask.astype(int))),
                "onlyEvents": bool(only_events),
                "maxRows": int(max_rows),
                "thresholdG": float(
                    accel_threshold_g if k == "harsh_accel" else brake_threshold_g
                ),
                "maxAbsAxG": float(np.nanmax(np.abs(ax_v))) if ax_v.size else 0.0,
            },
            **payload,
        }

    if k == "harsh_turns":
        try:
            yaw = get_accelerometers(trip, axis="yaw", downsample=1)
        except FileNotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e

        yaw_t = np.asarray(yaw.t, dtype=float)
        yaw_v = np.asarray(yaw.v, dtype=float)

        # Approx dyaw/dt on same sample index (yaw_rate at i uses i-1->i)
        if yaw_t.shape[0] >= 2:
            dy = np.diff(yaw_v)
            dt_y = np.diff(yaw_t)
            dt_y = np.where(dt_y > 0, dt_y, np.nan)
            yaw_rate = np.r_[np.nan, dy / dt_y]
        else:
            yaw_rate = np.full((yaw_t.shape[0],), np.nan)

        exceed = np.isfinite(yaw_rate) & (
            np.abs(yaw_rate) >= float(yaw_rate_threshold_dps)
        )

        # Mark only event starts (rising edges) to match ICM event counting.
        mask = exceed & np.logical_not(np.r_[False, exceed[:-1]])

        payload = _rows(
            yaw_t,
            ["t", "yawDeg", "yawRateDegPerS"],
            [yaw_v, yaw_rate],
            mask,
        )
        return {
            "tripId": trip.id,
            "kind": "harsh_turns",
            "offsetSeconds": trip.offset_seconds,
            "stats": {
                "totalSamples": int(mask.shape[0]),
                "exceedSamples": int(np.sum(exceed.astype(int))),
                "eventEdges": int(np.sum(mask.astype(int))),
                "onlyEvents": bool(only_events),
                "maxRows": int(max_rows),
                "thresholdDegPerS": float(yaw_rate_threshold_dps),
                "maxAbsYawRateDegPerS": (
                    float(np.nanmax(np.abs(yaw_rate))) if yaw_rate.size else 0.0
                ),
            },
            **payload,
        }

    raise HTTPException(status_code=400, detail=f"Unknown evidence kind: {kind}")


@app.get("/api/icm")
def get_icm(
    speed_margin_kmh: float = Query(default=5.0, ge=0.0, le=50.0),
    accel_threshold_g: float = Query(default=0.25, ge=0.0, le=5.0),
    brake_threshold_g: float = Query(default=0.35, ge=0.0, le=5.0),
    yaw_rate_threshold_dps: float = Query(default=18.0, ge=0.0, le=500.0),
    default_speed_limit_kmh: float = Query(default=120.0, ge=10.0, le=200.0),
) -> dict:
    idx = trip_index()

    trip_results = []
    for trip in idx.trips:
        try:
            r = compute_trip_icm(
                trip,
                speed_margin_kmh=speed_margin_kmh,
                accel_threshold_g=accel_threshold_g,
                brake_threshold_g=brake_threshold_g,
                yaw_rate_threshold_dps=yaw_rate_threshold_dps,
                default_speed_limit_kmh=default_speed_limit_kmh,
            )
            trip_results.append(r)
        except FileNotFoundError:
            # Skip trips missing required data
            continue

    drivers = aggregate_driver_scores(trip_results)
    return {
        "drivers": drivers,
        "trips": [t.to_dict() for t in trip_results],
        "params": {
            "speedMarginKmh": speed_margin_kmh,
            "accelThresholdG": accel_threshold_g,
            "brakeThresholdG": brake_threshold_g,
            "yawRateThresholdDps": yaw_rate_threshold_dps,
            "defaultSpeedLimitKmh": default_speed_limit_kmh,
        },
    }


# Serve the frontend as static files (mounted last so it doesn't shadow /api routes)
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
