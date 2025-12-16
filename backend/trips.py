from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Literal, Optional

import numpy as np

AccelAxis = Literal[
    "x",
    "y",
    "z",
    "x_kf",
    "y_kf",
    "z_kf",
    "roll",
    "pitch",
    "yaw",
]


_ACCEL_AXIS_TO_COL: dict[AccelAxis, int] = {
    "x": 2,
    "y": 3,
    "z": 4,
    "x_kf": 5,
    "y_kf": 6,
    "z_kf": 7,
    "roll": 8,
    "pitch": 9,
    "yaw": 10,
}


@dataclass(frozen=True)
class Trip:
    id: str
    folder_path: Path
    video_path: Optional[Path]
    data_start: Optional[datetime]
    video_start: Optional[datetime]
    offset_seconds: float

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "folderPath": str(self.folder_path),
            "videoPath": str(self.video_path) if self.video_path else None,
            "dataStart": self.data_start.isoformat() if self.data_start else None,
            "videoStart": self.video_start.isoformat() if self.video_start else None,
            "offsetSeconds": self.offset_seconds,
        }


@dataclass(frozen=True)
class TripIndex:
    trips: List[Trip]
    by_id: Dict[str, Trip]


@dataclass(frozen=True)
class Series:
    t: np.ndarray
    v: np.ndarray


@dataclass(frozen=True)
class GpsTrack:
    t: np.ndarray
    lat: np.ndarray
    lon: np.ndarray
    speed: np.ndarray


def get_events(trip: Trip, *, file_prefix: str | None = None) -> list[dict]:
    out: list[dict] = []

    # UAH DriveSet event files are stored per-trip and start with EVENTS.
    # Format is not strictly enforced here; we parse as:
    # - ignore empty lines
    # - ignore lines starting with '#'
    # - first token: float timestamp (seconds since route start)
    # - remaining tokens: label text
    for p in sorted(trip.folder_path.glob("EVENTS*")):
        if not p.is_file():
            continue
        if file_prefix and not p.name.startswith(file_prefix):
            continue
        try:
            with p.open("r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    s = line.strip()
                    if not s or s.startswith("#"):
                        continue
                    parts = s.split()
                    if len(parts) == 0:
                        continue
                    try:
                        t = float(parts[0])
                    except ValueError:
                        # Skip header/invalid rows
                        continue

                    direction = None
                    label = " ".join(parts[1:]).strip()
                    extras: list[str] = []
                    duration_seconds: float | None = None

                    if (
                        p.name.startswith("EVENTS_LIST_LANE_CHANGES")
                        and len(parts) >= 2
                    ):
                        try:
                            direction = int(float(parts[1]))
                        except ValueError:
                            direction = None
                        extras = parts[2:]
                        if len(parts) >= 4:
                            try:
                                duration_seconds = float(parts[3])
                            except ValueError:
                                duration_seconds = None
                            if duration_seconds is not None and duration_seconds <= 0:
                                duration_seconds = None
                        if direction == 1:
                            label = "Right"
                        elif direction == -1:
                            label = "Left"
                        else:
                            label = "LaneChange"

                    out.append(
                        {
                            "t": t,
                            "label": label,
                            "source": p.name,
                            "direction": direction,
                            "extras": extras,
                            "durationSeconds": duration_seconds,
                        }
                    )
        except OSError:
            # Ignore unreadable files
            continue

    out.sort(key=lambda e: e.get("t", 0.0))
    return out


_ALLOWED_SERIES_FILES: set[str] = {
    "RAW_ACCELEROMETERS",
    "RAW_GPS",
    "PROC_LANE_DETECTION",
    "PROC_VEHICLE_DETECTION",
    "PROC_OPENSTREETMAP_DATA",
    "SEMANTIC_ONLINE",
}


def get_available_series_files(trip: Trip) -> list[str]:
    out: list[str] = []
    for stem in sorted(_ALLOWED_SERIES_FILES):
        p = trip.folder_path / f"{stem}.txt"
        if p.exists() and p.is_file():
            out.append(stem)
    return out


_TABLE_COLUMN_NAMES: dict[str, list[str]] = {
    "RAW_ACCELEROMETERS": [
        "Activation bool (1 if speed>50Km/h)",
        "X acceleration (Gs)",
        "Y acceleration (Gs)",
        "Z acceleration (Gs)",
        "X accel filtered by KF (Gs)",
        "Y accel filtered by KF (Gs)",
        "Z accel filtered by KF (Gs)",
        "Roll (degrees)",
        "Pitch (degrees)",
        "Yaw (degrees)",
    ],
    "RAW_GPS": [
        "Speed (Km/h)",
        "Latitude",
        "Longitude",
        "Altitude",
        "Vertical accuracy",
        "Horizontal accuracy",
        "Course (degrees)",
        "Difcourse: course variation",
        "Position state [internal val]",
        "Lanex dist state [internal val]",
        "Lanex history [internal val]",
    ],
    "PROC_LANE_DETECTION": [
        "Car pos. from lane center (meters)",
        "Phi",
        "Road width (meters)",
        "State of lane estimator",
    ],
    "PROC_VEHICLE_DETECTION": [
        "Distance to ahead vehicle (meters)",
        "Impact time to ahead vehicle (secs.)",
        "Detected # of vehicles",
        "Gps speed (Km/h) [redundant val]",
    ],
    "PROC_OPENSTREETMAP_DATA": [
        "Current road maxspeed",
        "Maxspeed reliability [Flag]",
        "Road type [graph not available]",
        "# of lanes in road",
        "Estimated current lane",
        "Latitude used to query OSM",
        "Longitude used to query OSM",
        "Delay answer OSM query (seconds)",
        "Speed (Km/h) [redundant val]",
    ],
}


def _parse_datetime_prefix(name: str) -> Optional[datetime]:
    if len(name) < 14:
        return None
    prefix = name[:14]
    if not prefix.isdigit():
        return None
    try:
        return datetime.strptime(prefix, "%Y%m%d%H%M%S")
    except ValueError:
        return None


def _trip_id_from_relative_path(rel: Path) -> str:
    # Stable, URL-friendly id.
    return rel.as_posix().replace("/", "|")


def build_trip_index(dataset_root: Path) -> TripIndex:
    if not dataset_root.exists():
        raise FileNotFoundError(f"Dataset root not found: {dataset_root}")

    trips: list[Trip] = []

    # Trip folders are nested under D1..D6 and contain RAW_ACCELEROMETERS.txt
    for accel_path in dataset_root.glob("D*/**/RAW_ACCELEROMETERS.txt"):
        folder = accel_path.parent
        rel = folder.relative_to(dataset_root)
        trip_id = _trip_id_from_relative_path(rel)

        # Pick the first mp4 if present
        videos = sorted(folder.glob("*.mp4"))
        video_path = videos[0] if videos else None

        data_start = _parse_datetime_prefix(folder.name)
        video_start = _parse_datetime_prefix(video_path.name) if video_path else None

        offset_seconds = 0.0
        if data_start and video_start:
            offset_seconds = (data_start - video_start).total_seconds()

        trips.append(
            Trip(
                id=trip_id,
                folder_path=folder,
                video_path=video_path,
                data_start=data_start,
                video_start=video_start,
                offset_seconds=offset_seconds,
            )
        )

    trips.sort(key=lambda t: t.id)
    by_id = {t.id: t for t in trips}
    return TripIndex(trips=trips, by_id=by_id)


def get_accelerometers(trip: Trip, axis: AccelAxis, downsample: int = 1) -> Series:
    accel_path = trip.folder_path / "RAW_ACCELEROMETERS.txt"
    if not accel_path.exists():
        raise FileNotFoundError(f"RAW_ACCELEROMETERS not found: {accel_path}")

    col = _ACCEL_AXIS_TO_COL[axis]

    # File is space-delimited. Column 0 is timestamp since route start.
    data = np.loadtxt(str(accel_path), dtype=float)
    t = data[:, 0]
    v = data[:, col]

    if downsample > 1:
        t = t[::downsample]
        v = v[::downsample]

    return Series(t=t, v=v)


def get_table(
    trip: Trip,
    file_stem: str,
    *,
    downsample: int = 1,
    offset: int = 0,
    limit: int = 200,
) -> tuple[list[str], np.ndarray, int]:
    if file_stem not in _ALLOWED_SERIES_FILES:
        raise ValueError(f"File not allowed: {file_stem}")
    if downsample < 1:
        raise ValueError("downsample must be >= 1")
    if offset < 0:
        raise ValueError("offset must be >= 0")
    if limit < 1:
        raise ValueError("limit must be >= 1")

    path = trip.folder_path / f"{file_stem}.txt"
    if not path.exists():
        raise FileNotFoundError(f"Table file not found: {path}")

    data = np.loadtxt(str(path), dtype=float)
    if downsample > 1:
        data = data[::downsample]

    total = int(data.shape[0])
    start = min(offset, total)
    end = min(start + limit, total)
    slice_ = data[start:end]

    expected_cols = int(data.shape[1]) - 1
    names = _TABLE_COLUMN_NAMES.get(file_stem)
    if names and len(names) == expected_cols:
        col_names = names
    else:
        col_names = [f"col{i}" for i in range(1, expected_cols + 1)]

    columns = ["t"] + col_names
    return columns, slice_, total


def get_gps_track(trip: Trip, downsample: int = 1) -> GpsTrack:
    gps_path = trip.folder_path / "RAW_GPS.txt"
    if not gps_path.exists():
        raise FileNotFoundError(f"RAW_GPS not found: {gps_path}")

    data = np.loadtxt(str(gps_path), dtype=float)
    # Column mapping based on dataset reader:
    # 0: timestamp since route start
    # 1: speed (Km/h)
    # 2: latitude
    # 3: longitude
    t = data[:, 0]
    speed = data[:, 1]
    lat = data[:, 2]
    lon = data[:, 3]

    if downsample > 1:
        t = t[::downsample]
        speed = speed[::downsample]
        lat = lat[::downsample]
        lon = lon[::downsample]

    return GpsTrack(t=t, lat=lat, lon=lon, speed=speed)


def get_series(trip: Trip, file_stem: str, col: int, downsample: int = 1) -> Series:
    """Load a (t, v) series from a dataset text file.

    - `file_stem`: e.g. RAW_GPS (without .txt)
    - `col`: 1-based column index excluding time (col=1 means 2nd column in file)
    """

    if file_stem not in _ALLOWED_SERIES_FILES:
        raise ValueError(f"File not allowed: {file_stem}")
    if col < 1:
        raise ValueError("col must be >= 1")

    path = trip.folder_path / f"{file_stem}.txt"
    if not path.exists():
        raise FileNotFoundError(f"Series file not found: {path}")

    # Some dataset files can contain non-numeric columns (e.g. OSM road type like
    # 'motorway'). When the caller requests a single numeric series, read only
    # the required columns (time + target column) to avoid parse failures.
    col0 = col  # file column index, since data[:,0] is time.
    data = np.genfromtxt(
        str(path),
        dtype=float,
        usecols=(0, col0),
        invalid_raise=False,
    )

    if data.ndim != 2 or data.shape[1] != 2:
        raise ValueError("Failed to parse series file")

    t = data[:, 0]
    v = data[:, 1]

    if downsample > 1:
        t = t[::downsample]
        v = v[::downsample]

    return Series(t=t, v=v)
