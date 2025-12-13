let state = {
  trips: [],
  currentTrip: null,
  downsample: 10,
  windowSeconds: 30,
  offsetSeconds: 0,
  panels: [],
  gps: null,
};

const STORAGE_KEY = "uah_driveset_web_viewer_state_v1";

function loadPersistedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  // Bearing from point1 to point2 in degrees, 0 = North.
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  const brng = toDeg(Math.atan2(y, x));
  return (brng + 360) % 360;
}

function rotateMarker(deg) {
  if (!gpsMarker) return;
  const el = gpsMarker.getElement?.();
  if (!el) return;
  const rot = el.querySelector?.(".vehRot");
  if (!rot) return;
  // SVG rotation expects degrees clockwise. Our bearing is 0=N.
  // The arrow points up (north) at 0 degrees.
  rot.setAttribute("transform", `rotate(${deg.toFixed(1)})`);
}

function savePersistedState(patch) {
  const prev = loadPersistedState() || {};
  const next = { ...prev, ...patch, savedAt: Date.now() };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

function safeNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const els = {
  driverSelect: document.getElementById("driverSelect"),
  tripSelect: document.getElementById("tripSelect"),
  windowSeconds: document.getElementById("windowSeconds"),
  downsample: document.getElementById("downsample"),
  reloadBtn: document.getElementById("reloadBtn"),
  video: document.getElementById("video"),
  meta: document.getElementById("meta"),
  plots: document.getElementById("plots"),
  map: document.getElementById("map"),
};

let leafletMap = null;
let gpsPolyline = null;
let gpsMarker = null;
let lastMapCenterMs = 0;
const VEHICLE_FOLLOW_ZOOM = 16;

function ensureMap() {
  if (leafletMap) return leafletMap;
  if (!window.L || !els.map) return null;

  leafletMap = L.map(els.map, {
    zoomControl: true,
    attributionControl: false,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
  }).addTo(leafletMap);

  // Default view until data arrives
  leafletMap.setView([0, 0], 2);
  return leafletMap;
}

function setGpsTrackOnMap(lat, lon) {
  const map = ensureMap();
  if (!map) return;

  if (gpsPolyline) {
    gpsPolyline.remove();
    gpsPolyline = null;
  }
  if (gpsMarker) {
    gpsMarker.remove();
    gpsMarker = null;
  }

  const points = [];
  for (let i = 0; i < lat.length; i++) {
    const la = lat[i];
    const lo = lon[i];
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    points.push([la, lo]);
  }
  if (points.length === 0) return;

  gpsPolyline = L.polyline(points, {
    color: "#6ea8fe",
    weight: 3,
    opacity: 0.85,
  }).addTo(map);
  const icon = L.divIcon({
    className: "vehicleMarker",
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    html: `
      <svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
        <g transform="translate(14,14)">
          <g class="vehRot" transform="rotate(0)">
            <path d="M0,-11 L8,9 L0,5 L-8,9 Z" fill="#ff3b30" stroke="#ffffff" stroke-width="2" stroke-linejoin="round" />
          </g>
        </g>
      </svg>
    `,
  });
  gpsMarker = L.marker(points[0], { icon }).addTo(map);

  // Start with a route overview, then jump to a closer follow zoom.
  map.fitBounds(gpsPolyline.getBounds(), { padding: [10, 10] });
  map.setView(points[0], VEHICLE_FOLLOW_ZOOM, { animate: false });
}

function updateGpsMarker(tData) {
  if (!state.gps || !gpsMarker || !leafletMap) return;
  const idx = findClosestIndex(state.gps.t, tData);
  if (idx < 0) return;
  const la = state.gps.lat[idx];
  const lo = state.gps.lon[idx];
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return;

  gpsMarker.setLatLng([la, lo]);

  // Infer heading from neighboring point
  const j = Math.min(state.gps.t.length - 1, idx + 1);
  const k = Math.max(0, idx - 1);
  const la2 = state.gps.lat[j];
  const lo2 = state.gps.lon[j];
  const la1 = state.gps.lat[k];
  const lo1 = state.gps.lon[k];
  if (
    Number.isFinite(la1) &&
    Number.isFinite(lo1) &&
    Number.isFinite(la2) &&
    Number.isFinite(lo2)
  ) {
    const b = bearingDeg(la1, lo1, la2, lo2);
    rotateMarker(b);
  }

  // Keep map centered on the vehicle (throttled)
  const now = Date.now();
  if (now - lastMapCenterMs > 250) {
    lastMapCenterMs = now;
    // Keep at least VEHICLE_FOLLOW_ZOOM unless user zoomed in even more.
    const z = Math.max(leafletMap.getZoom(), VEHICLE_FOLLOW_ZOOM);
    leafletMap.setView([la, lo], z, { animate: true, duration: 0.25 });
  }
}

function byId(id) {
  return state.trips.find((t) => t.id === id) || null;
}

function driverFromTripId(tripId) {
  // trip id format is relative path with / replaced by |
  // e.g. D1|201511...-SECONDARY
  if (!tripId || typeof tripId !== "string") return "";
  return tripId.split("|")[0] || "";
}

function tripLabelFromTripId(tripId) {
  if (!tripId || typeof tripId !== "string") return tripId;
  const parts = tripId.split("|");
  return parts[1] || tripId;
}

function uniqueSorted(arr) {
  return Array.from(new Set(arr)).sort();
}

function renderDriverOptions(drivers, selected) {
  els.driverSelect.innerHTML = "";
  for (const d of drivers) {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    els.driverSelect.appendChild(opt);
  }
  if (selected && drivers.includes(selected)) {
    els.driverSelect.value = selected;
  } else if (drivers.length > 0) {
    els.driverSelect.value = drivers[0];
  }
}

function renderTripOptionsForDriver(driver, preferredTripId) {
  const tripsForDriver = state.trips.filter(
    (t) => driverFromTripId(t.id) === driver
  );
  els.tripSelect.innerHTML = "";
  for (const t of tripsForDriver) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = tripLabelFromTripId(t.id);
    els.tripSelect.appendChild(opt);
  }

  if (
    preferredTripId &&
    byId(preferredTripId) &&
    driverFromTripId(preferredTripId) === driver
  ) {
    els.tripSelect.value = preferredTripId;
  } else if (tripsForDriver.length > 0) {
    els.tripSelect.value = tripsForDriver[0].id;
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function findClosestIndex(sortedArr, value) {
  // Binary search for closest index in ascending sortedArr
  let lo = 0;
  let hi = sortedArr.length - 1;
  if (hi < 0) return -1;

  if (value <= sortedArr[0]) return 0;
  if (value >= sortedArr[hi]) return hi;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = sortedArr[mid];
    if (v === value) return mid;
    if (v < value) lo = mid + 1;
    else hi = mid - 1;
  }

  // lo is insertion point
  const i1 = clamp(lo, 0, sortedArr.length - 1);
  const i0 = clamp(lo - 1, 0, sortedArr.length - 1);
  return Math.abs(sortedArr[i1] - value) < Math.abs(sortedArr[i0] - value)
    ? i1
    : i0;
}

function findBracket(sortedArr, value) {
  // Returns indices [i0, i1] such that sortedArr[i0] <= value <= sortedArr[i1]
  // Clamps to endpoints.
  let lo = 0;
  let hi = sortedArr.length - 1;
  if (hi < 0) return [-1, -1];
  if (value <= sortedArr[0]) return [0, 0];
  if (value >= sortedArr[hi]) return [hi, hi];

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = sortedArr[mid];
    if (v === value) return [mid, mid];
    if (v < value) lo = mid + 1;
    else hi = mid - 1;
  }
  const i1 = clamp(lo, 0, sortedArr.length - 1);
  const i0 = clamp(lo - 1, 0, sortedArr.length - 1);
  return [i0, i1];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function interpolatedY(tArr, vArr, t) {
  if (!tArr || tArr.length === 0) return null;
  const [i0, i1] = findBracket(tArr, t);
  if (i0 < 0 || i1 < 0) return null;
  if (i0 === i1) return vArr[i0];
  const t0 = tArr[i0];
  const t1 = tArr[i1];
  const v0 = vArr[i0];
  const v1 = vArr[i1];
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 === t0) return v0;
  const alpha = (t - t0) / (t1 - t0);
  return lerp(v0, v1, clamp(alpha, 0, 1));
}

function makeChart(canvasEl, label) {
  const tickLabel = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    return n.toFixed(2);
  };

  const monoFont = {
    family:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  };

  return new Chart(canvasEl, {
    type: "line",
    data: {
      datasets: [
        {
          label,
          data: [],
          borderColor: "#6ea8fe",
          backgroundColor: "rgba(110,168,254,0.15)",
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.15,
        },
        {
          label: "Cursor",
          data: [],
          borderColor: "#ffffff",
          backgroundColor: "#ffffff",
          pointRadius: 3,
          showLine: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      scales: {
        x: {
          type: "linear",
          title: { display: true, text: "t (s)" },
          grid: { color: "rgba(255,255,255,0.06)" },
          ticks: {
            color: "rgba(255,255,255,0.8)",
            callback: tickLabel,
            font: monoFont,
          },
        },
        y: {
          title: { display: true, text: "value" },
          grid: { color: "rgba(255,255,255,0.06)" },
          ticks: {
            color: "rgba(255,255,255,0.8)",
            callback: tickLabel,
            font: monoFont,
          },
        },
      },
      plugins: {
        legend: { labels: { color: "rgba(255,255,255,0.85)" } },
        tooltip: { enabled: true },
      },
    },
  });
}

function defaultPanelSpecs() {
  const specs = [
    {
      key: "accel_x",
      title: "RAW_ACCELEROMETERS (x)",
      subtitle: "Acceleration (Gs)",
      kind: "accelerometers",
      axis: "x",
    },
    {
      key: "accel_y",
      title: "RAW_ACCELEROMETERS (y)",
      subtitle: "Acceleration (Gs)",
      kind: "accelerometers",
      axis: "y",
    },
    {
      key: "accel_z",
      title: "RAW_ACCELEROMETERS (z)",
      subtitle: "Acceleration (Gs)",
      kind: "accelerometers",
      axis: "z",
    },
  ];

  specs.push(
    {
      key: "veh_dist",
      title: "PROC_VEHICLE_DETECTION",
      subtitle: "Distance to ahead vehicle (m)",
      kind: "series",
      file: "PROC_VEHICLE_DETECTION",
      col: 1,
    },
    {
      key: "gps_speed",
      title: "RAW_GPS",
      subtitle: "Speed (Km/h)",
      kind: "series",
      file: "RAW_GPS",
      col: 1,
    }
  );

  return specs;
}

function buildPanels(specs) {
  els.plots.innerHTML = "";
  state.panels = specs.map((spec) => {
    const card = document.createElement("div");
    card.className = "plot";

    const header = document.createElement("div");
    header.className = "plotHeader";

    const title = document.createElement("div");
    title.className = "plotTitle";
    title.textContent = spec.title;

    const sub = document.createElement("div");
    sub.className = "plotSub";
    sub.textContent = spec.subtitle || "";

    header.appendChild(title);
    header.appendChild(sub);

    const wrap = document.createElement("div");
    wrap.className = "plotCanvasWrap";

    const canvas = document.createElement("canvas");
    wrap.appendChild(canvas);

    card.appendChild(header);
    card.appendChild(wrap);
    els.plots.appendChild(card);

    const chart = makeChart(canvas, spec.title);
    return { spec, chart, t: [], v: [] };
  });
}

async function loadTrips() {
  const res = await fetch("/api/trips");
  if (!res.ok) throw new Error("Failed to load trips");
  const json = await res.json();
  state.trips = json.trips || [];

  const persisted = loadPersistedState();

  const drivers = uniqueSorted(
    state.trips.map((t) => driverFromTripId(t.id)).filter(Boolean)
  );
  const preferredTrip =
    persisted?.tripId && byId(persisted.tripId) ? persisted.tripId : null;
  const preferredDriver =
    (persisted?.driver &&
      drivers.includes(persisted.driver) &&
      persisted.driver) ||
    (preferredTrip ? driverFromTripId(preferredTrip) : null) ||
    (drivers.length ? drivers[0] : "");

  renderDriverOptions(drivers, preferredDriver);
  renderTripOptionsForDriver(els.driverSelect.value, preferredTrip);

  if (els.driverSelect.value)
    savePersistedState({ driver: els.driverSelect.value });
  if (els.tripSelect.value)
    savePersistedState({ tripId: els.tripSelect.value });

  if (els.tripSelect.value) {
    state.currentTrip = byId(els.tripSelect.value);
  }
}

async function loadTripData() {
  const tripId = els.tripSelect.value;
  const trip = byId(tripId);
  if (!trip) return;
  state.currentTrip = trip;

  const persisted = loadPersistedState();
  state.downsample = Number(els.downsample.value) || 1;
  state.windowSeconds = Number(els.windowSeconds.value) || 30;

  els.video.src = `/api/trips/${encodeURIComponent(tripId)}/video`;

  const specs = defaultPanelSpecs();
  buildPanels(specs);

  // Load each panel data
  let offsetSeconds = 0;
  for (const p of state.panels) {
    if (p.spec.kind === "accelerometers") {
      const url = `/api/trips/${encodeURIComponent(
        tripId
      )}/accelerometers?axis=${encodeURIComponent(
        p.spec.axis
      )}&downsample=${encodeURIComponent(state.downsample)}`;
      const res = await fetch(url);
      if (!res.ok)
        throw new Error(`Failed to load accelerometers (${p.spec.axis})`);
      const json = await res.json();
      offsetSeconds = json.offsetSeconds || 0;
      p.t = json.t || [];
      p.v = json.v || [];
    } else {
      const url = `/api/trips/${encodeURIComponent(
        tripId
      )}/series?file=${encodeURIComponent(
        p.spec.file
      )}&col=${encodeURIComponent(p.spec.col)}&downsample=${encodeURIComponent(
        state.downsample
      )}`;
      const res = await fetch(url);
      if (!res.ok)
        throw new Error(
          `Failed to load series ${p.spec.file} col ${p.spec.col}`
        );
      const json = await res.json();
      offsetSeconds = json.offsetSeconds || 0;
      p.t = json.t || [];
      p.v = json.v || [];
    }

    p.chart.data.datasets[0].label = p.spec.title;
    p.chart.data.datasets[0].data = p.t.map((t, i) => ({ x: t, y: p.v[i] }));
    p.chart.data.datasets[1].data = [];
    p.chart.update();
  }

  state.offsetSeconds = offsetSeconds;

  // Load GPS track for the map
  state.gps = null;
  try {
    const gpsUrl = `/api/trips/${encodeURIComponent(
      tripId
    )}/gps?downsample=${encodeURIComponent(state.downsample)}`;
    const gpsRes = await fetch(gpsUrl);
    if (gpsRes.ok) {
      const gpsJson = await gpsRes.json();
      state.gps = {
        t: gpsJson.t || [],
        lat: gpsJson.lat || [],
        lon: gpsJson.lon || [],
      };
      setGpsTrackOnMap(state.gps.lat, state.gps.lon);
    }
  } catch {
    // ignore map failures
  }

  // Restore video time only when re-loading the same trip
  if (persisted?.tripId === tripId && typeof persisted.videoTime === "number") {
    const t = Math.max(0, persisted.videoTime);
    const applyTime = () => {
      try {
        els.video.currentTime = t;
      } catch {
        // ignore
      }
      updateCursor();
    };
    if (els.video.readyState >= 1) applyTime();
    else
      els.video.addEventListener("loadedmetadata", applyTime, { once: true });
  }

  // Restore scroll position of the plots column
  if (typeof persisted?.plotsScrollTop === "number") {
    els.plots.scrollTop = Math.max(0, persisted.plotsScrollTop);
  }

  // Persist key UI selections
  savePersistedState({
    tripId,
    downsample: state.downsample,
    windowSeconds: state.windowSeconds,
  });

  els.meta.textContent = [
    `Trip: ${trip.id}`,
    `Folder: ${trip.folderPath}`,
    `Video: ${trip.videoPath ?? "(not found)"}`,
    `OffsetSeconds (dataStart - videoStart): ${state.offsetSeconds.toFixed(3)}`,
    "",
    "Sync rule:",
    "t_data = video.currentTime - offsetSeconds",
  ].join("\n");
}

function updateCursor() {
  const tVideo = els.video.currentTime || 0;
  const tData = tVideo - state.offsetSeconds;

  const w = Math.max(2, state.windowSeconds);
  for (const p of state.panels) {
    if (!p.t || p.t.length === 0) continue;
    const y = interpolatedY(p.t, p.v, tData);
    if (y == null) continue;
    // Use exact tData for x so the cursor moves smoothly even if sampling is coarse.
    p.chart.data.datasets[1].data = [{ x: tData, y }];
    p.chart.options.scales.x.min = tData - w / 2;
    p.chart.options.scales.x.max = tData + w / 2;
    p.chart.update("none");
  }

  updateGpsMarker(tData);
}

let rafId = null;
let lastFrameMs = 0;
const TARGET_FPS = 30;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

function startSmoothLoop() {
  if (rafId != null) return;
  const tick = (ms) => {
    rafId = requestAnimationFrame(tick);
    if (!els.video) return;

    // Only update when video is playing or user is seeking (time can still change when paused).
    if (ms - lastFrameMs < FRAME_INTERVAL_MS) return;
    lastFrameMs = ms;
    updateCursor();
  };
  rafId = requestAnimationFrame(tick);
}

function stopSmoothLoop() {
  if (rafId == null) return;
  cancelAnimationFrame(rafId);
  rafId = null;
}

function attachEvents() {
  els.driverSelect.addEventListener("change", () => {
    const driver = els.driverSelect.value;
    savePersistedState({ driver, videoTime: 0 });
    renderTripOptionsForDriver(driver, null);
    savePersistedState({ tripId: els.tripSelect.value, videoTime: 0 });
    loadTripData().catch((e) => (els.meta.textContent = String(e)));
  });

  els.tripSelect.addEventListener("change", () => {
    savePersistedState({ tripId: els.tripSelect.value, videoTime: 0 });
    loadTripData().catch((e) => (els.meta.textContent = String(e)));
  });

  els.reloadBtn.addEventListener("click", () => {
    loadTripData().catch((e) => (els.meta.textContent = String(e)));
  });

  els.windowSeconds.addEventListener("change", () => {
    state.windowSeconds = Number(els.windowSeconds.value) || 30;
    savePersistedState({ windowSeconds: state.windowSeconds });
    updateCursor();
  });

  els.downsample.addEventListener("change", () => {
    savePersistedState({ downsample: safeNumber(els.downsample.value, 10) });
  });

  els.plots.addEventListener("scroll", () => {
    savePersistedState({ plotsScrollTop: els.plots.scrollTop });
  });

  let lastVideoPersist = 0;
  const persistVideoTimeThrottled = () => {
    const now = Date.now();
    if (now - lastVideoPersist < 1000) return;
    lastVideoPersist = now;
    savePersistedState({ videoTime: els.video.currentTime || 0 });
  };

  // Smooth visual updates are driven by requestAnimationFrame.
  els.video.addEventListener("timeupdate", persistVideoTimeThrottled);
  els.video.addEventListener("seeked", updateCursor);
  els.video.addEventListener("seeked", () =>
    savePersistedState({ videoTime: els.video.currentTime || 0 })
  );
  els.video.addEventListener("loadedmetadata", updateCursor);
  els.video.addEventListener("play", startSmoothLoop);
  els.video.addEventListener("pause", () => {
    stopSmoothLoop();
    updateCursor();
  });
}

async function main() {
  attachEvents();

  // Restore persisted values into inputs before initial load
  const persisted = loadPersistedState();
  if (persisted) {
    if (typeof persisted.windowSeconds === "number")
      els.windowSeconds.value = String(persisted.windowSeconds);
    if (typeof persisted.downsample === "number")
      els.downsample.value = String(persisted.downsample);
  }

  await loadTrips();
  await loadTripData();

  // If the video is already playing when the page loads, start the loop.
  if (!els.video.paused) startSmoothLoop();
}

main().catch((e) => {
  els.meta.textContent = String(e);
});
