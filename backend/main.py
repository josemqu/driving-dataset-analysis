from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .trips import (
    AccelAxis,
    TripIndex,
    build_trip_index,
    get_accelerometers,
    get_gps_track,
    get_series,
)


APP_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIR = APP_ROOT / "frontend"

DATASET_ROOT = Path(
    os.environ.get(
        "UAH_DATASET_ROOT",
        str((APP_ROOT.parent / "UAH-DRIVESET-v1").resolve()),
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
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {
        "tripId": trip.id,
        "file": file,
        "col": col,
        "offsetSeconds": trip.offset_seconds,
        "t": data.t.tolist(),
        "v": data.v.tolist(),
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
        raise HTTPException(status_code=404, detail=str(e))

    return {
        "tripId": trip.id,
        "offsetSeconds": trip.offset_seconds,
        "t": gps.t.tolist(),
        "lat": gps.lat.tolist(),
        "lon": gps.lon.tolist(),
        "speed": gps.speed.tolist(),
    }


# Serve the frontend as static files (mounted last so it doesn't shadow /api routes)
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
