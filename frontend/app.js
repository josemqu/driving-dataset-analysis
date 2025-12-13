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

const PANELS_ORDER_KEY = "panelsOrder";

function getPersistedPanelsOrder() {
  const persisted = loadPersistedState();
  const order = persisted?.[PANELS_ORDER_KEY];
  if (!Array.isArray(order)) return null;
  return order.filter((k) => typeof k === "string" && k.length > 0);
}

function persistPanelsOrder(keys) {
  if (!Array.isArray(keys)) return;
  const unique = [];
  const seen = new Set();
  for (const k of keys) {
    if (typeof k !== "string" || !k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(k);
  }
  savePersistedState({ [PANELS_ORDER_KEY]: unique });
}

function orderPanelSpecs(specs, persistedOrder) {
  if (!Array.isArray(specs) || specs.length === 0) return specs;
  if (!Array.isArray(persistedOrder) || persistedOrder.length === 0)
    return specs;

  const byKey = new Map();
  for (const s of specs) {
    if (!s || typeof s.key !== "string") continue;
    byKey.set(s.key, s);
  }

  const out = [];
  const used = new Set();
  for (const k of persistedOrder) {
    const s = byKey.get(k);
    if (!s || used.has(k)) continue;
    used.add(k);
    out.push(s);
  }

  for (const s of specs) {
    if (!s || typeof s.key !== "string") continue;
    if (used.has(s.key)) continue;
    used.add(s.key);
    out.push(s);
  }

  return out;
}

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
  // Smooth rotation using CSS transform (CSS handles transition).
  // Our bearing is 0=N and the arrow points up at 0 degrees.
  rot.style.transform = `rotate(${deg.toFixed(1)}deg)`;
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
  videoOverlayPlay: document.getElementById("videoOverlayPlay"),
  videoOverlay: document.getElementById("videoOverlay"),
  videoWrap: document.getElementById("videoWrap"),
  meta: document.getElementById("meta"),
  plots: document.getElementById("plots"),
  map: document.getElementById("map"),
};

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncateMiddle(s, maxLen) {
  const str = String(s);
  if (!Number.isFinite(maxLen) || maxLen <= 0) return str;
  if (str.length <= maxLen) return str;
  const head = Math.max(1, Math.floor((maxLen - 1) * 0.55));
  const tail = Math.max(1, maxLen - 1 - head);
  return `${str.slice(0, head)}…${str.slice(str.length - tail)}`;
}

function renderMetaPanel({ tripId, folderPath, videoPath, offsetSeconds }) {
  const items = [
    { label: "Trip", value: tripId ?? "" },
    { label: "Folder", value: folderPath ?? "" },
    { label: "Video", value: videoPath ?? "(not found)" },
    {
      label: "OffsetSeconds (dataStart - videoStart)",
      value: Number.isFinite(offsetSeconds)
        ? offsetSeconds.toFixed(3)
        : String(offsetSeconds ?? ""),
    },
  ];

  els.meta.innerHTML = `
    <div class="metaPanel">
      <div class="metaTitle">Trip info</div>
      <div class="metaGrid">
        ${items
          .map((it) => {
            const raw = String(it.value ?? "");
            const short = truncateMiddle(raw, 90);
            const safeShort = escapeHtml(short);
            const safeRaw = escapeHtml(raw);
            const safeLabel = escapeHtml(it.label);
            return `
              <div class="metaRow">
                <div class="metaLabel">${safeLabel}</div>
                <div class="metaValue" title="${safeRaw}"><code>${safeShort}</code></div>
                <button class="metaCopy" type="button" data-copy="${safeRaw}" aria-label="Copy ${safeLabel}" title="Copy">Copy</button>
              </div>
            `;
          })
          .join("")}
      </div>
      <div class="metaRule">
        <div class="metaRuleTitle">Sync rule</div>
        <code>t_data = video.currentTime - offsetSeconds</code>
      </div>
    </div>
  `;
}

function renderMetaError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  els.meta.innerHTML = `
    <div class="metaPanel metaPanelError">
      <div class="metaTitle">Error</div>
      <div class="metaErrorText"><code>${escapeHtml(msg)}</code></div>
    </div>
  `;
}

function setVideoOverlayVisible(visible) {
  if (!els.videoOverlay) return;
  els.videoOverlay.classList.toggle("isHidden", !visible);
}

function syncVideoOverlay() {
  if (!els.video) return;
  const isPlaying = !els.video.paused && !els.video.ended;
  if (els.videoWrap) els.videoWrap.classList.toggle("isPlaying", isPlaying);

  // When paused (and not ended), show the overlay. When playing, CSS will show it on hover.
  const shouldShow = els.video.paused && !els.video.ended;
  setVideoOverlayVisible(shouldShow);

  // Swap icon: play when paused, pause when playing.
  if (els.videoOverlayPlay)
    els.videoOverlayPlay.classList.toggle("isPause", isPlaying);
}

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
    if (leafletMap.getZoom() !== z) {
      leafletMap.setZoom(z, { animate: true });
    }
    leafletMap.panTo([la, lo], {
      animate: true,
      duration: 0.35,
      easeLinearity: 0.25,
    });
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

function windowMinMax(tArr, vArr, tMin, tMax) {
  if (!tArr || tArr.length === 0) return null;
  const [a] = findBracket(tArr, tMin);
  const [, b] = findBracket(tArr, tMax);
  if (a < 0 || b < 0) return null;
  const i0 = Math.min(a, b);
  const i1 = Math.max(a, b);
  let min = Infinity;
  let max = -Infinity;
  for (let i = i0; i <= i1; i++) {
    const y = vArr[i];
    if (!Number.isFinite(y)) continue;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  if (min === Infinity || max === -Infinity) return null;
  if (min === max) {
    const pad = Math.max(1e-6, Math.abs(min) * 0.01);
    return { min: min - pad, max: max + pad };
  }
  return { min, max };
}

function makeChart(canvasEl, label) {
  const tickLabel = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    return n.toFixed(2);
  };

  const xTickLabel = function (value, index, ticks) {
    // When the window is tight, the min tick on X can overlap with other labels.
    // Hide the first tick label (usually the min).
    if (index === 0) return "";
    return tickLabel(value);
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
      layout: {
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
      },
      scales: {
        x: {
          type: "linear",
          title: { display: false },
          grid: {
            color: "rgba(255,255,255,0.06)",
            tickColor: "rgba(255,255,255,0.05)",
            tickLength: 0,
            drawTicks: false,
          },
          border: { color: "rgba(255,255,255,0.18)" },
          ticks: {
            color: "rgba(255,255,255,0.8)",
            callback: xTickLabel,
            font: monoFont,
            padding: 2,
            maxTicksLimit: 6,
            autoSkip: true,
            maxRotation: 0,
            minRotation: 0,
          },
        },
        y: {
          title: { display: false },
          grid: {
            color: "rgba(255,255,255,0.06)",
            tickColor: "rgba(255,255,255,0.05)",
            tickLength: 0,
            drawTicks: false,
          },
          border: { color: "rgba(255,255,255,0.18)" },
          ticks: {
            color: "rgba(255,255,255,0.8)",
            callback: tickLabel,
            font: monoFont,
            padding: 2,
            maxTicksLimit: 5,
          },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          displayColors: false,
          titleFont: monoFont,
          bodyFont: monoFont,
          padding: 8,
        },
      },
      interaction: {
        mode: "nearest",
        intersect: false,
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
    card.dataset.panelKey = spec.key;
    card.draggable = true;

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

    if (spec.kind === "accelerometers") {
      // Emphasize the zero line for accelerometer plots.
      const normal = "rgba(255,255,255,0.06)";
      const zero = "rgba(255,255,255,0.22)";
      chart.options.scales.y.grid.color = (ctx) => {
        const v = ctx?.tick?.value;
        return v === 0 ? zero : normal;
      };
    }
    return { spec, chart, t: [], v: [] };
  });

  attachPlotsDnD();
}

function attachPlotsDnD() {
  const container = els.plots;
  if (!container) return;

  const cards = Array.from(container.querySelectorAll(".plot"));
  if (cards.length === 0) return;

  const canUseDnD = "draggable" in document.createElement("div");
  if (!canUseDnD) return;

  let draggingKey = null;

  const indexForKey = (key) => {
    const children = Array.from(container.querySelectorAll(".plot"));
    return children.findIndex((el) => el.dataset.panelKey === key);
  };

  const persistCurrentDomOrder = () => {
    const keys = Array.from(container.querySelectorAll(".plot"))
      .map((el) => el.dataset.panelKey)
      .filter(Boolean);
    persistPanelsOrder(keys);
  };

  const clearDragOver = () => {
    container
      .querySelectorAll(".plot.dragOver")
      .forEach((el) => el.classList.remove("dragOver"));
  };

  for (const card of cards) {
    card.addEventListener("dragstart", (e) => {
      draggingKey = card.dataset.panelKey || null;
      card.classList.add("dragging");
      try {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", draggingKey || "");
      } catch {
        // ignore
      }
    });

    card.addEventListener("dragend", () => {
      draggingKey = null;
      card.classList.remove("dragging");
      clearDragOver();
      persistCurrentDomOrder();
    });

    card.addEventListener("dragover", (e) => {
      if (!draggingKey) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!card.classList.contains("dragOver")) {
        clearDragOver();
        card.classList.add("dragOver");
      }
    });

    card.addEventListener("dragleave", () => {
      card.classList.remove("dragOver");
    });

    card.addEventListener("drop", (e) => {
      e.preventDefault();
      const srcKey = draggingKey;
      const dstKey = card.dataset.panelKey || null;
      if (!srcKey || !dstKey || srcKey === dstKey) return;

      const srcEl = container.querySelector(
        `.plot[data-panel-key="${CSS.escape(srcKey)}"]`
      );
      const dstEl = container.querySelector(
        `.plot[data-panel-key="${CSS.escape(dstKey)}"]`
      );
      if (!srcEl || !dstEl) return;

      const srcIndex = indexForKey(srcKey);
      const dstIndex = indexForKey(dstKey);
      if (srcIndex < 0 || dstIndex < 0) return;

      // Insert src before/after dst based on relative position.
      if (srcIndex < dstIndex) {
        container.insertBefore(srcEl, dstEl.nextSibling);
      } else {
        container.insertBefore(srcEl, dstEl);
      }

      // Keep state.panels aligned with DOM order so updates stay correct.
      const order = Array.from(container.querySelectorAll(".plot"))
        .map((el) => el.dataset.panelKey)
        .filter(Boolean);
      const byKey = new Map(state.panels.map((p) => [p.spec.key, p]));
      const nextPanels = [];
      for (const k of order) {
        const p = byKey.get(k);
        if (p) nextPanels.push(p);
      }
      // In case any panel wasn't in DOM order (shouldn't happen), keep them at the end.
      for (const p of state.panels) {
        const k = p?.spec?.key;
        if (!k) continue;
        if (order.includes(k)) continue;
        nextPanels.push(p);
      }
      state.panels = nextPanels;

      clearDragOver();
      persistPanelsOrder(order);
    });
  }
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
  if (!tripId) return;
  const trip = byId(tripId);
  if (!trip) return;
  state.currentTrip = trip;

  const persisted = loadPersistedState();
  state.downsample = Number(els.downsample.value) || 1;
  state.windowSeconds = Number(els.windowSeconds.value) || 30;

  els.video.src = `/api/trips/${encodeURIComponent(tripId)}/video`;

  const defaultSpecs = defaultPanelSpecs();
  const persistedOrder = getPersistedPanelsOrder();
  const specs = orderPanelSpecs(defaultSpecs, persistedOrder);
  // If there's no persisted order yet, store the current default order.
  if (!persistedOrder) persistPanelsOrder(defaultSpecs.map((s) => s.key));
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

  renderMetaPanel({
    tripId: trip.id,
    folderPath: trip.folderPath,
    videoPath: trip.videoPath,
    offsetSeconds: state.offsetSeconds,
  });
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

    const mm = windowMinMax(p.t, p.v, tData - w / 2, tData + w / 2);
    if (mm) {
      const range = mm.max - mm.min;
      const pad = range * 0.08;
      let targetMin = mm.min - pad;
      let targetMax = mm.max + pad;

      if (p.spec.kind === "accelerometers") {
        // Symmetric range around 0 makes accel plots easier to compare.
        const maxAbs = Math.max(Math.abs(targetMin), Math.abs(targetMax));
        targetMin = -maxAbs;
        targetMax = maxAbs;
      }

      if (
        p.spec.key === "veh_dist" ||
        p.spec.file === "PROC_VEHICLE_DETECTION"
      ) {
        // Proximity/distance can't be negative; keep baseline at 0.
        targetMin = 0;
        // Ensure a non-zero range so the chart doesn't collapse when values are flat.
        if (!Number.isFinite(targetMax) || targetMax <= 0) targetMax = 1;
      }
      const alpha = 0.18;
      p.yMinSmooth =
        typeof p.yMinSmooth === "number"
          ? lerp(p.yMinSmooth, targetMin, alpha)
          : targetMin;
      p.yMaxSmooth =
        typeof p.yMaxSmooth === "number"
          ? lerp(p.yMaxSmooth, targetMax, alpha)
          : targetMax;
      if (Number.isFinite(p.yMinSmooth) && Number.isFinite(p.yMaxSmooth)) {
        const eps = 1e-6;
        const ymin = Math.min(p.yMinSmooth, p.yMaxSmooth - eps);
        const ymax = Math.max(p.yMaxSmooth, p.yMinSmooth + eps);
        p.chart.options.scales.y.min = ymin;
        p.chart.options.scales.y.max = ymax;
      }
    }
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
  if (els.videoOverlayPlay && els.video) {
    els.videoOverlayPlay.addEventListener("click", () => {
      if (els.video.paused || els.video.ended) {
        // Best effort: if play is blocked by autoplay policy, it will reject.
        const p = els.video.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } else {
        els.video.pause();
      }

      // Avoid keeping focus on the overlay button (can make hover-like behavior feel sticky).
      try {
        els.videoOverlayPlay.blur();
      } catch {
        // ignore
      }
    });

    // Keep overlay state correct when user uses native controls.
    els.video.addEventListener("play", syncVideoOverlay);
    els.video.addEventListener("pause", syncVideoOverlay);
    els.video.addEventListener("ended", syncVideoOverlay);
    els.video.addEventListener("loadedmetadata", syncVideoOverlay);
    els.video.addEventListener("emptied", syncVideoOverlay);
  }

  els.driverSelect.addEventListener("change", () => {
    const driver = els.driverSelect.value;
    savePersistedState({ driver, videoTime: 0 });
    renderTripOptionsForDriver(driver, null);
    savePersistedState({ tripId: els.tripSelect.value, videoTime: 0 });
    loadTripData().catch((e) => renderMetaError(e));
  });

  els.tripSelect.addEventListener("change", () => {
    savePersistedState({ tripId: els.tripSelect.value, videoTime: 0 });
    loadTripData().catch((e) => renderMetaError(e));
  });

  els.reloadBtn.addEventListener("click", () => {
    loadTripData().catch((e) => renderMetaError(e));
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

  els.meta.addEventListener("click", async (ev) => {
    const btn = ev.target?.closest?.("button.metaCopy");
    if (!btn) return;
    const raw = btn.getAttribute("data-copy") ?? "";
    try {
      await navigator.clipboard.writeText(raw);
      const prev = btn.textContent;
      btn.textContent = "Copied";
      window.setTimeout(() => {
        btn.textContent = prev;
      }, 900);
    } catch {
      // ignore clipboard failures
    }
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
  renderMetaError(e);
});
