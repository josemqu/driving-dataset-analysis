let state = {
  trips: [],
  currentTrip: null,
  downsample: 10,
  windowSeconds: 30,
  offsetSeconds: 0,
  panels: [],
  gps: null,
  gpsRaw: null,
  events: [],
};

const SYNC_OVERRIDES_KEY = "syncOverrides";

function defaultSyncOverrideSeconds(tripId) {
  const tid = String(tripId || "");
  if (tid.includes("20151111125233-24km-D1-AGGRESSIVE-MOTORWAY")) return 0;
  return null;
}

function getSyncOverrideSeconds(tripId) {
  const tid = String(tripId || "");
  if (!tid) return null;
  const persisted = loadPersistedState();
  const overrides = persisted?.[SYNC_OVERRIDES_KEY];
  const fromPersisted =
    overrides && typeof overrides === "object" ? overrides[tid] : undefined;
  const n = Number(fromPersisted);
  if (Number.isFinite(n)) return n;
  return defaultSyncOverrideSeconds(tid);
}

function setSyncOverrideSeconds(tripId, value) {
  const tid = String(tripId || "");
  if (!tid) return;
  const persisted = loadPersistedState() || {};
  const current = persisted?.[SYNC_OVERRIDES_KEY];
  const overrides =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...current }
      : {};
  if (value == null) delete overrides[tid];
  else overrides[tid] = Number(value);
  savePersistedState({ [SYNC_OVERRIDES_KEY]: overrides });
}

function parseQuery() {
  try {
    const sp = new URLSearchParams(window.location.search);
    const tripId = sp.get("tripId") || "";
    const tDataRaw = sp.get("tData");
    const videoTimeRaw = sp.get("videoTime");
    const leadRaw = sp.get("lead");
    const tData = tDataRaw != null ? Number(tDataRaw) : null;
    const videoTime = videoTimeRaw != null ? Number(videoTimeRaw) : null;
    const lead = leadRaw != null ? Number(leadRaw) : null;
    return {
      tripId,
      tData: Number.isFinite(tData) ? tData : null,
      videoTime: Number.isFinite(videoTime) ? videoTime : null,
      lead: Number.isFinite(lead) ? lead : null,
    };
  } catch {
    return { tripId: "", tData: null, videoTime: null, lead: null };
  }
}

function seekVideoToRequestedTime(query) {
  if (!els.video) return;
  if (!query) return;

  const lead = Math.max(0, safeNumber(query.lead, 2));

  // If a data-time is provided, convert to video time using the sync rule.
  let target = null;
  if (typeof query.tData === "number") {
    target = query.tData + state.offsetSeconds;
  } else if (typeof query.videoTime === "number") {
    target = query.videoTime;
  }
  if (target == null) return;

  const t = Math.max(0, target - lead);
  const applyTime = () => {
    try {
      els.video.currentTime = t;
    } catch {
      // ignore
    }
    updateCursor();
  };

  if (els.video.readyState >= 1) applyTime();
  else els.video.addEventListener("loadedmetadata", applyTime, { once: true });
}

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

function kalman1DConstVelWithVel(t, z, sigmaA, sigmaZ) {
  const n = Array.isArray(t) ? t.length : 0;
  const pos = new Array(n);
  const vel = new Array(n);
  if (n === 0) return { pos, vel };

  const sA = Math.max(0, Number(sigmaA));
  const sZ = Math.max(0, Number(sigmaZ));
  const q = sA * sA;
  const r = sZ * sZ;

  let x0 = Number(z[0]);
  if (!Number.isFinite(x0)) x0 = 0;
  let x1 = 0;
  let p00 = 10;
  let p01 = 0;
  let p10 = 0;
  let p11 = 10;

  pos[0] = x0;
  vel[0] = x1;
  for (let i = 1; i < n; i++) {
    const ti0 = Number(t[i - 1]);
    const ti1 = Number(t[i]);
    const dtRaw = ti1 - ti0;
    const dt = Number.isFinite(dtRaw) && dtRaw > 0 ? dtRaw : 0;

    const x0p = x0 + dt * x1;
    const x1p = x1;

    const fp00 = p00 + dt * (p10 + p01) + dt * dt * p11;
    const fp01 = p01 + dt * p11;
    const fp10 = p10 + dt * p11;
    const fp11 = p11;

    const dt2 = dt * dt;
    const dt3 = dt2 * dt;
    const dt4 = dt2 * dt2;
    const q00 = 0.25 * dt4 * q;
    const q01 = 0.5 * dt3 * q;
    const q11 = dt2 * q;

    let pp00 = fp00 + q00;
    let pp01 = fp01 + q01;
    let pp10 = fp10 + q01;
    let pp11 = fp11 + q11;

    const zi = Number(z[i]);
    if (!Number.isFinite(zi) || dt === 0) {
      x0 = x0p;
      x1 = x1p;
      p00 = pp00;
      p01 = pp01;
      p10 = pp10;
      p11 = pp11;
      pos[i] = x0;
      vel[i] = x1;
      continue;
    }

    const y = zi - x0p;
    const s = pp00 + r;
    const k0 = s !== 0 ? pp00 / s : 0;
    const k1 = s !== 0 ? pp10 / s : 0;

    x0 = x0p + k0 * y;
    x1 = x1p + k1 * y;

    const p00n = (1 - k0) * pp00;
    const p01n = (1 - k0) * pp01;
    const p10n = pp10 - k1 * pp00;
    const p11n = pp11 - k1 * pp01;

    p00 = p00n;
    p01 = p01n;
    p10 = p10n;
    p11 = p11n;

    pos[i] = x0;
    vel[i] = x1;
  }
  return { pos, vel };
}

function kalmanGpsLocalMeters(t, lat, lon, sigmaA, sigmaZ) {
  const n = Array.isArray(t) ? t.length : 0;
  if (n === 0) return { t: [], lat: [], lon: [], speedKmh: [] };

  const lat0 = Number(lat[0]);
  const lon0 = Number(lon[0]);
  if (!Number.isFinite(lat0) || !Number.isFinite(lon0)) {
    return { t, lat: Array.from(lat), lon: Array.from(lon), speedKmh: [] };
  }

  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const phi0 = toRad(lat0);
  const cos0 = Math.cos(phi0);

  const x = new Array(n);
  const y = new Array(n);
  for (let i = 0; i < n; i++) {
    const la = Number(lat[i]);
    const lo = Number(lon[i]);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) {
      x[i] = NaN;
      y[i] = NaN;
      continue;
    }
    x[i] = toRad(lo - lon0) * R * cos0;
    y[i] = toRad(la - lat0) * R;
  }

  const kx = kalman1DConstVelWithVel(t, x, sigmaA, sigmaZ);
  const ky = kalman1DConstVelWithVel(t, y, sigmaA, sigmaZ);

  const latOut = new Array(n);
  const lonOut = new Array(n);
  const speedKmh = new Array(n);
  for (let i = 0; i < n; i++) {
    const xi = kx.pos[i];
    const yi = ky.pos[i];
    const vxi = kx.vel[i];
    const vyi = ky.vel[i];
    if (!Number.isFinite(xi) || !Number.isFinite(yi)) {
      latOut[i] = NaN;
      lonOut[i] = NaN;
    } else {
      latOut[i] = lat0 + toDeg(yi / R);
      lonOut[i] = lon0 + toDeg(xi / (R * cos0));
    }
    if (Number.isFinite(vxi) && Number.isFinite(vyi)) {
      speedKmh[i] = Math.sqrt(vxi * vxi + vyi * vyi) * 3.6;
    } else {
      speedKmh[i] = NaN;
    }
  }

  return { t, lat: latOut, lon: lonOut, speedKmh };
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
  sidebarToggle: document.getElementById("sidebarToggle"),
  driverSelect: document.getElementById("driverSelect"),
  tripSelect: document.getElementById("tripSelect"),
  windowSeconds: document.getElementById("windowSeconds"),
  downsample: document.getElementById("downsample"),
  gpsFilter: document.getElementById("gpsFilter"),
  gpsResample10Hz: document.getElementById("gpsResample10Hz"),
  gpsMaWindow: document.getElementById("gpsMaWindow"),
  gpsKalmanSigmaA: document.getElementById("gpsKalmanSigmaA"),
  gpsKalmanSigmaZ: document.getElementById("gpsKalmanSigmaZ"),
  accelFilter: document.getElementById("accelFilter"),
  accelMaWindow: document.getElementById("accelMaWindow"),
  accelKalmanSigmaA: document.getElementById("accelKalmanSigmaA"),
  accelKalmanSigmaZ: document.getElementById("accelKalmanSigmaZ"),
  tableDrawerToggle: document.getElementById("tableDrawerToggle"),
  tableDrawerBody: document.getElementById("tableDrawerBody"),
  tableFile: document.getElementById("tableFile"),
  tableDownsample: document.getElementById("tableDownsample"),
  tableOffset: document.getElementById("tableOffset"),
  tableLimit: document.getElementById("tableLimit"),
  tableLoad: document.getElementById("tableLoad"),
  tableOpenTab: document.getElementById("tableOpenTab"),
  tableMeta: document.getElementById("tableMeta"),
  tableWrap: document.getElementById("tableWrap"),
  reloadBtn: document.getElementById("reloadBtn"),
  video: document.getElementById("video"),
  videoTimeOverlay: document.getElementById("videoTimeOverlay"),
  videoTripOverlay: document.getElementById("videoTripOverlay"),
  videoOverlayPlay: document.getElementById("videoOverlayPlay"),
  videoOverlay: document.getElementById("videoOverlay"),
  videoWrap: document.getElementById("videoWrap"),
  meta: document.getElementById("meta"),
  plots: document.getElementById("plots"),
  map: document.getElementById("map"),
};

function formatStopwatchSeconds(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return "0.000";
  // Show total seconds with milliseconds (no minutes breakdown)
  return s.toFixed(3);
}

function updateVideoTimeOverlay() {
  if (!els.videoTimeOverlay || !els.video) return;
  els.videoTimeOverlay.textContent = `${formatStopwatchSeconds(
    els.video.currentTime || 0
  )} s`;
}

function updateVideoTripOverlay() {
  if (!els.videoTripOverlay) return;
  const tripId = els.tripSelect?.value || "";
  if (!tripId) {
    els.videoTripOverlay.textContent = "";
    return;
  }
  const driver = driverFromTripId(tripId);
  const tripLabel = tripLabelFromTripId(tripId);
  els.videoTripOverlay.textContent = `${driver} · ${tripLabel}`;
}

function speedingEvidenceToRangeEvents(json, offsetSeconds) {
  const rows = Array.isArray(json?.rows) ? json.rows : [];
  if (rows.length < 2) return [];

  const off = Number(offsetSeconds) || 0;

  let start = null;
  let end = null;
  const out = [];

  for (let i = 0; i < rows.length - 1; i++) {
    const r0 = Array.isArray(rows[i]) ? rows[i] : [];
    const r1 = Array.isArray(rows[i + 1]) ? rows[i + 1] : [];
    const t0 = Number(r0[0]);
    const t1 = Number(r1[0]);
    const isEvent = Boolean(r0[r0.length - 1]);
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) continue;
    if (t1 <= t0) continue;

    if (!isEvent) {
      if (start != null && end != null && end > start) {
        out.push({
          t: start + off,
          durationSeconds: end - start,
          label: "Speeding",
          source: "SPEEDING_RANGE",
        });
      }
      start = null;
      end = null;
      continue;
    }

    if (start == null) {
      start = t0;
      end = t1;
    } else {
      end = t1;
    }
  }

  if (start != null && end != null && end > start) {
    out.push({
      t: start + off,
      durationSeconds: end - start,
      label: "Speeding",
      source: "SPEEDING_RANGE",
    });
  }

  return out;
}

function setSidebarCollapsed(collapsed) {
  const main = document.querySelector?.("main.main");
  if (!main) return;
  main.classList.toggle("sidebarCollapsed", !!collapsed);
  if (els.sidebarToggle) {
    els.sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  }
}

function setTableDrawerOpen(open) {
  if (!els.tableDrawerBody || !els.tableDrawerToggle) return;
  const isOpen = !!open;
  els.tableDrawerBody.hidden = !isOpen;
  els.tableDrawerToggle.setAttribute("aria-expanded", String(isOpen));
}

function renderTableError(err) {
  if (!els.tableWrap) return;
  const msg = err instanceof Error ? err.message : String(err);
  if (els.tableMeta) els.tableMeta.textContent = "";
  els.tableWrap.innerHTML = `<div style="padding:10px"><code>${escapeHtml(
    msg
  )}</code></div>`;
}

function renderTable(columns, rows, meta) {
  if (!els.tableWrap) return;
  const cols = Array.isArray(columns) ? columns : [];
  const rws = Array.isArray(rows) ? rows : [];
  const timeShiftSeconds = Number(meta?.offsetSeconds) || 0;
  const hasTimeCol = cols.length > 0 && String(cols[0]) === "t";
  const addVideoTimeCol =
    hasTimeCol && Number.isFinite(timeShiftSeconds) && timeShiftSeconds !== 0;

  if (els.tableMeta) {
    const parts = [];
    if (meta?.file) parts.push(`file=${meta.file}`);
    if (typeof meta?.downsample === "number")
      parts.push(`downsample=${meta.downsample}`);
    if (typeof meta?.offset === "number") parts.push(`offset=${meta.offset}`);
    if (typeof meta?.limit === "number") parts.push(`limit=${meta.limit}`);
    if (typeof meta?.total === "number") parts.push(`total=${meta.total}`);
    els.tableMeta.textContent = parts.join(" · ");
  }

  const displayCols = addVideoTimeCol
    ? [cols[0], "t_video", ...cols.slice(1)]
    : cols;

  const thead = `<thead><tr>${displayCols
    .map((c) => `<th><code>${escapeHtml(c)}</code></th>`)
    .join("")}</tr></thead>`;
  const tbody = `<tbody>${rws
    .map((row) => {
      const cells = Array.isArray(row) ? row : [];
      if (!addVideoTimeCol) {
        return `<tr>${cols
          .map((_, i) => {
            const v = cells[i];
            const s = Number.isFinite(v)
              ? Number(v).toFixed(6)
              : String(v ?? "");
            return `<td><code>${escapeHtml(s)}</code></td>`;
          })
          .join("")}</tr>`;
      }

      const tRaw = Number(cells[0]);
      const tVideo = Number.isFinite(tRaw) ? tRaw + timeShiftSeconds : cells[0];
      return `<tr>${displayCols
        .map((c, j) => {
          let v;
          if (j === 0) v = cells[0];
          else if (j === 1) v = tVideo;
          else v = cells[j - 1];
          const s = Number.isFinite(v) ? Number(v).toFixed(6) : String(v ?? "");
          return `<td><code>${escapeHtml(s)}</code></td>`;
        })
        .join("")}</tr>`;
    })
    .join("")}</tbody>`;
  els.tableWrap.innerHTML = `<table class="dataTable">${thead}${tbody}</table>`;
}

async function loadTableData() {
  const tripId = els.tripSelect?.value;
  if (!tripId) throw new Error("No trip selected");

  const file = String(els.tableFile?.value || "RAW_GPS");
  const downsample = clamp(safeNumber(els.tableDownsample?.value, 10), 1, 1000);
  const offset = Math.max(0, Math.floor(safeNumber(els.tableOffset?.value, 0)));
  const limit = clamp(
    Math.floor(safeNumber(els.tableLimit?.value, 200)),
    1,
    2000
  );

  savePersistedState({
    tableOpen: true,
    tableFile: file,
    tableDownsample: downsample,
    tableOffset: offset,
    tableLimit: limit,
  });

  const url = `/api/trips/${encodeURIComponent(
    tripId
  )}/table?file=${encodeURIComponent(file)}&downsample=${encodeURIComponent(
    downsample
  )}&offset=${encodeURIComponent(offset)}&limit=${encodeURIComponent(limit)}`;

  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Failed to load table (${res.status}) ${txt}`.trim());
  }
  const json = await res.json();
  renderTable(json.columns, json.rows, {
    file: json.file,
    downsample: json.downsample,
    offset: json.offset,
    limit: json.limit,
    total: json.total,
    offsetSeconds: json.offsetSeconds,
  });
}

function openTableInNewTab() {
  const tripId = els.tripSelect?.value;
  if (!tripId) return;
  const file = String(els.tableFile?.value || "RAW_GPS");
  const downsample = clamp(safeNumber(els.tableDownsample?.value, 10), 1, 1000);
  const offset = Math.max(0, Math.floor(safeNumber(els.tableOffset?.value, 0)));
  const limit = clamp(
    Math.floor(safeNumber(els.tableLimit?.value, 200)),
    1,
    2000
  );
  const url = `/tables.html?tripId=${encodeURIComponent(
    tripId
  )}&file=${encodeURIComponent(file)}&downsample=${encodeURIComponent(
    downsample
  )}&offset=${encodeURIComponent(offset)}&limit=${encodeURIComponent(limit)}`;
  window.open(url, "_blank", "noopener");
}

function clampOddInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  const c = clamp(Math.round(x), min, max);
  return c % 2 === 1 ? c : clamp(c + 1, min, max);
}

function accelFilterSettingsFromUi() {
  const kind = String(els.accelFilter?.value || "none");
  const maWindow = clampOddInt(els.accelMaWindow?.value, 1, 301, 9);
  const sigmaA = clamp(safeNumber(els.accelKalmanSigmaA?.value, 1.5), 0, 50);
  const sigmaZ = clamp(safeNumber(els.accelKalmanSigmaZ?.value, 6), 0, 100);
  return { kind, maWindow, sigmaA, sigmaZ };
}

function applyAccelFilter1D(t, vRaw, settings) {
  if (!Array.isArray(t) || !Array.isArray(vRaw) || t.length !== vRaw.length)
    return Array.isArray(vRaw) ? Array.from(vRaw) : [];
  if (settings.kind === "ma") {
    return applyMovingAverageCentered(vRaw, settings.maWindow);
  }
  if (settings.kind === "kalman") {
    return kalman1DConstVel(t, vRaw, settings.sigmaA, settings.sigmaZ);
  }
  return Array.from(vRaw);
}

function applyAccelFilterToPanels() {
  const s = accelFilterSettingsFromUi();
  for (const p of state.panels) {
    if (p?.spec?.kind !== "accelerometers") continue;
    if (p?.spec?.applyAccelFilter === false) continue;
    if (!Array.isArray(p.t) || !Array.isArray(p.v) || p.t.length === 0)
      continue;

    // Preserve raw values
    p.vRaw =
      Array.isArray(p.vRaw) && p.vRaw.length === p.v.length
        ? p.vRaw
        : Array.from(p.v);
    const smooth = applyAccelFilter1D(p.t, p.vRaw, s);
    p.vSmooth = smooth;
    p.vForCursor = s.kind === "none" ? p.vRaw : p.vSmooth;

    // Dataset 0: raw, dataset 2: smoothed
    p.chart.data.datasets[0].label = `RAW_ACCELEROMETERS (${p.spec.axis}) raw`;
    p.chart.data.datasets[0].data = p.t.map((tt, i) => ({
      x: tt,
      y: p.vRaw[i],
    }));

    if (p.chart.data.datasets[2]) {
      p.chart.data.datasets[2].hidden = s.kind === "none";
      p.chart.data.datasets[2].label = `RAW_ACCELEROMETERS (${p.spec.axis}) ${
        s.kind === "kalman" ? "kalman" : "ma"
      }`;
      p.chart.data.datasets[2].data = p.t.map((tt, i) => ({
        x: tt,
        y: smooth[i],
      }));
    }

    p.yMinSmooth = undefined;
    p.yMaxSmooth = undefined;
    p.chart.update("none");
  }

  // Ensure cursor and scales reflect the updated series
  updateCursor();
}

function gpsFilterSettingsFromUi() {
  const kind = String(els.gpsFilter?.value || "none");
  const resample10Hz = !!els.gpsResample10Hz?.checked;
  const maWindow = clampOddInt(els.gpsMaWindow?.value, 1, 301, 9);
  const sigmaA = safeNumber(els.gpsKalmanSigmaA?.value, 1.5);
  const sigmaZ = safeNumber(els.gpsKalmanSigmaZ?.value, 6);
  return {
    kind,
    resample10Hz,
    maWindow,
    sigmaA: Math.max(0, sigmaA),
    sigmaZ: Math.max(0, sigmaZ),
  };
}

function resampleGpsTo10HzLocalMeters(gpsRaw) {
  if (!gpsRaw || !Array.isArray(gpsRaw.t)) return null;
  const tIn = gpsRaw.t || [];
  const latIn = gpsRaw.lat || [];
  const lonIn = gpsRaw.lon || [];
  const n = tIn.length;
  if (n === 0) return { t: [], lat: [], lon: [] };

  // Establish origin
  const lat0 = Number(latIn[0]);
  const lon0 = Number(lonIn[0]);
  if (!Number.isFinite(lat0) || !Number.isFinite(lon0)) {
    return {
      t: Array.from(tIn),
      lat: Array.from(latIn),
      lon: Array.from(lonIn),
    };
  }

  // Build a clean list of valid samples (monotonic time, finite coords)
  const samples = [];
  for (let i = 0; i < n; i++) {
    const ti = Number(tIn[i]);
    const la = Number(latIn[i]);
    const lo = Number(lonIn[i]);
    if (!Number.isFinite(ti) || !Number.isFinite(la) || !Number.isFinite(lo))
      continue;
    if (samples.length > 0 && ti <= samples[samples.length - 1].t) continue;
    samples.push({ t: ti, lat: la, lon: lo });
  }
  if (samples.length < 2) {
    return {
      t: samples.map((s) => s.t),
      lat: samples.map((s) => s.lat),
      lon: samples.map((s) => s.lon),
    };
  }

  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const phi0 = toRad(lat0);
  const cos0 = Math.cos(phi0);

  const t0 = samples[0].t;
  const tN = samples[samples.length - 1].t;
  const dt = 0.1;
  const m = Math.max(1, Math.floor((tN - t0) / dt) + 1);

  const tOut = new Array(m);
  const xOut = new Array(m);
  const yOut = new Array(m);

  // Two-pointer linear interpolation in local meters
  let j = 0;
  for (let k = 0; k < m; k++) {
    const tk = t0 + k * dt;
    tOut[k] = tk;

    while (j + 1 < samples.length && samples[j + 1].t < tk) j++;
    const a = samples[j];
    const b = samples[Math.min(samples.length - 1, j + 1)];
    if (!a || !b) {
      xOut[k] = NaN;
      yOut[k] = NaN;
      continue;
    }
    const denom = b.t - a.t;
    const alpha = denom > 0 ? (tk - a.t) / denom : 0;
    const aa = clamp01(alpha);

    // Convert endpoints to meters
    const ax = toRad(a.lon - lon0) * R * cos0;
    const ay = toRad(a.lat - lat0) * R;
    const bx = toRad(b.lon - lon0) * R * cos0;
    const by = toRad(b.lat - lat0) * R;

    xOut[k] = lerp(ax, bx, aa);
    yOut[k] = lerp(ay, by, aa);
  }

  // Back to lat/lon
  const latOut = new Array(m);
  const lonOut = new Array(m);
  for (let k = 0; k < m; k++) {
    const xi = xOut[k];
    const yi = yOut[k];
    if (!Number.isFinite(xi) || !Number.isFinite(yi)) {
      latOut[k] = NaN;
      lonOut[k] = NaN;
      continue;
    }
    latOut[k] = lat0 + toDeg(yi / R);
    lonOut[k] = lon0 + toDeg(xi / (R * cos0));
  }

  return { t: tOut, lat: latOut, lon: lonOut };
}

function applyMovingAverageCentered(arr, windowSize) {
  const n = Array.isArray(arr) ? arr.length : 0;
  const out = new Array(n);
  const w = clampOddInt(windowSize, 1, 301, 9);
  const half = Math.floor(w / 2);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let cnt = 0;
    const a = Math.max(0, i - half);
    const b = Math.min(n - 1, i + half);
    for (let j = a; j <= b; j++) {
      const v = arr[j];
      if (!Number.isFinite(v)) continue;
      sum += v;
      cnt++;
    }
    out[i] = cnt > 0 ? sum / cnt : Number(arr[i]);
  }
  return out;
}

// 1D constant-velocity Kalman filter with per-sample dt.
// State: [pos, vel]. Measurement: pos.
function kalman1DConstVel(t, z, sigmaA, sigmaZ) {
  const n = Array.isArray(t) ? t.length : 0;
  const out = new Array(n);
  if (n === 0) return out;

  const sA = Math.max(0, Number(sigmaA));
  const sZ = Math.max(0, Number(sigmaZ));
  const q = sA * sA;
  const r = sZ * sZ;

  let x0 = Number(z[0]);
  if (!Number.isFinite(x0)) x0 = 0;
  let x1 = 0;
  let p00 = 10;
  let p01 = 0;
  let p10 = 0;
  let p11 = 10;

  out[0] = x0;
  for (let i = 1; i < n; i++) {
    const ti0 = Number(t[i - 1]);
    const ti1 = Number(t[i]);
    const dtRaw = ti1 - ti0;
    const dt = Number.isFinite(dtRaw) && dtRaw > 0 ? dtRaw : 0;

    // Predict: x = F x
    const x0p = x0 + dt * x1;
    const x1p = x1;

    // Predict covariance: P = F P F^T + Q
    // F = [[1, dt], [0, 1]]
    const fp00 = p00 + dt * (p10 + p01) + dt * dt * p11;
    const fp01 = p01 + dt * p11;
    const fp10 = p10 + dt * p11;
    const fp11 = p11;

    // Q for constant-accel noise
    const dt2 = dt * dt;
    const dt3 = dt2 * dt;
    const dt4 = dt2 * dt2;
    const q00 = 0.25 * dt4 * q;
    const q01 = 0.5 * dt3 * q;
    const q11 = dt2 * q;

    let pp00 = fp00 + q00;
    let pp01 = fp01 + q01;
    let pp10 = fp10 + q01;
    let pp11 = fp11 + q11;

    // Update with measurement z
    const zi = Number(z[i]);
    if (!Number.isFinite(zi) || dt === 0) {
      x0 = x0p;
      x1 = x1p;
      p00 = pp00;
      p01 = pp01;
      p10 = pp10;
      p11 = pp11;
      out[i] = x0;
      continue;
    }

    // Innovation
    const y = zi - x0p;
    const s = pp00 + r;
    const k0 = s !== 0 ? pp00 / s : 0;
    const k1 = s !== 0 ? pp10 / s : 0;

    x0 = x0p + k0 * y;
    x1 = x1p + k1 * y;

    // P = (I - K H) P where H=[1,0]
    const p00n = (1 - k0) * pp00;
    const p01n = (1 - k0) * pp01;
    const p10n = pp10 - k1 * pp00;
    const p11n = pp11 - k1 * pp01;

    p00 = p00n;
    p01 = p01n;
    p10 = p10n;
    p11 = p11n;

    out[i] = x0;
  }
  return out;
}

function applyGpsFilter(gpsRaw, settings) {
  if (!gpsRaw || !Array.isArray(gpsRaw.t)) return null;
  const base = settings.resample10Hz
    ? resampleGpsTo10HzLocalMeters(gpsRaw)
    : gpsRaw;
  if (!base || !Array.isArray(base.t)) return null;
  const t = base.t || [];
  const lat = base.lat || [];
  const lon = base.lon || [];
  if (settings.kind === "ma") {
    return {
      t,
      lat: applyMovingAverageCentered(lat, settings.maWindow),
      lon: applyMovingAverageCentered(lon, settings.maWindow),
    };
  }
  if (settings.kind === "kalman") {
    return kalmanGpsLocalMeters(t, lat, lon, settings.sigmaA, settings.sigmaZ);
  }
  return { t, lat: Array.from(lat), lon: Array.from(lon) };
}

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
  const override = getSyncOverrideSeconds(tripId);
  const effectiveOffsetSeconds =
    override == null ? offsetSeconds : Number(override) || 0;
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
    {
      label: "EffectiveOffsetSeconds (used for plots)",
      value: Number.isFinite(effectiveOffsetSeconds)
        ? effectiveOffsetSeconds.toFixed(3)
        : String(effectiveOffsetSeconds ?? ""),
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
        <code>t_plot (video seconds) = t_data + offsetSeconds</code>
      </div>
      <div class="metaRule">
        <div class="metaRuleTitle">Sync override (this browser)</div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
          <input id="syncOverrideSeconds" type="number" step="0.01" style="width:140px" value="${escapeHtml(
            override == null ? "" : String(override)
          )}" placeholder="(none)" />
          <button id="syncOverrideApply" type="button">Apply</button>
          <button id="syncOverrideReset" type="button">Reset</button>
        </div>
        <div style="opacity:0.8; margin-top:6px">
          <code>Set to 0 to make data time match video time</code>
        </div>
      </div>
    </div>
  `;

  const applyBtn = document.getElementById("syncOverrideApply");
  const resetBtn = document.getElementById("syncOverrideReset");
  const input = document.getElementById("syncOverrideSeconds");
  if (applyBtn && input) {
    applyBtn.addEventListener("click", () => {
      const raw = String(input.value || "").trim();
      const n = Number(raw);
      if (raw === "") {
        setSyncOverrideSeconds(tripId, null);
      } else if (Number.isFinite(n)) {
        setSyncOverrideSeconds(tripId, n);
      }
      loadTripData().catch((e) => renderMetaError(e));
    });
  }
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      setSyncOverrideSeconds(tripId, null);
      loadTripData().catch((e) => renderMetaError(e));
    });
  }
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
const VEHICLE_FOLLOW_ZOOM = 15;

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function mixHex(a, b, t) {
  const parse = (hex) => {
    const h = String(hex).replace("#", "");
    const n = parseInt(h, 16);
    return {
      r: (n >> 16) & 255,
      g: (n >> 8) & 255,
      b: n & 255,
    };
  };
  const toHex = ({ r, g, b }) => {
    const n = ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
    return `#${n.toString(16).padStart(6, "0")}`;
  };
  const c0 = parse(a);
  const c1 = parse(b);
  const tt = clamp01(t);
  return toHex({
    r: Math.round(lerp(c0.r, c1.r, tt)),
    g: Math.round(lerp(c0.g, c1.g, tt)),
    b: Math.round(lerp(c0.b, c1.b, tt)),
  });
}

function colorForSpeedKmh(speedKmh) {
  const s = Number(speedKmh);
  const s0 = 0;
  const s1 = 120;
  const t = clamp01((s - s0) / (s1 - s0));
  if (t <= 0.25) return mixHex("#2563eb", "#22d3ee", t / 0.25);
  if (t <= 0.5) return mixHex("#22d3ee", "#22c55e", (t - 0.25) / 0.25);
  if (t <= 0.75) return mixHex("#22c55e", "#fbbf24", (t - 0.5) / 0.25);
  return mixHex("#fbbf24", "#ef4444", (t - 0.75) / 0.25);
}

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

function setGpsTrackOnMap(t, lat, lon) {
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
  const ts = Array.isArray(t) ? t : [];
  for (let i = 0; i < lat.length; i++) {
    const la = lat[i];
    const lo = lon[i];
    const ti = ts[i];
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    if (!Number.isFinite(ti)) continue;
    points.push({ la, lo, ti });
  }
  if (points.length === 0) return;

  const segs = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dt = b.ti - a.ti;
    if (!Number.isFinite(dt) || dt <= 0) continue;
    const d = haversineMeters(a.la, a.lo, b.la, b.lo);
    if (!Number.isFinite(d) || d <= 0) continue;
    const vKmh = (d / dt) * 3.6;
    segs.push(
      L.polyline(
        [
          [a.la, a.lo],
          [b.la, b.lo],
        ],
        {
          color: colorForSpeedKmh(vKmh),
          weight: 6,
          opacity: 0.95,
        }
      )
    );
  }
  gpsPolyline = L.featureGroup(segs).addTo(map);
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
  gpsMarker = L.marker([points[0].la, points[0].lo], { icon }).addTo(map);

  // Start with a route overview, then jump to a closer follow zoom.
  map.fitBounds(gpsPolyline.getBounds(), { padding: [10, 10] });
  map.setView([points[0].la, points[0].lo], VEHICLE_FOLLOW_ZOOM, {
    animate: false,
  });
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

const odometerOverlayPlugin = {
  id: "odometerOverlay",
  afterDatasetsDraw(chart) {
    const cfg = chart?.options?.plugins?.odometerOverlay;
    if (!cfg || !cfg.enabled) return;
    const ca = chart.chartArea;
    if (!ca) return;
    const ctx = chart.ctx;
    if (!ctx) return;

    const max = Number.isFinite(cfg.max) ? cfg.max : 160;
    const valueRaw = Number(chart.$odometerValue);
    const value = Number.isFinite(valueRaw) ? Math.max(0, valueRaw) : 0;
    const v = Math.min(max, value);
    const t = max > 0 ? v / max : 0;

    const radius = Math.max(34, Math.min(56, (ca.right - ca.left) * 0.18));
    const cx = ca.right - radius - 10;
    const cy = ca.top + radius + 40;
    const a0 = Math.PI;
    const a1 = 2 * Math.PI;
    const ang = a0 + (a1 - a0) * t;

    ctx.save();
    ctx.globalAlpha = 0.95;

    ctx.beginPath();
    ctx.arc(cx, cy, radius, a0, a1);
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, radius, a0, ang);
    ctx.strokeStyle = "rgba(34, 211, 238, 0.95)";
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.stroke();

    const needleLen = radius * 0.72;
    const nx = cx + Math.cos(ang) * needleLen;
    const ny = cy + Math.sin(ang) * needleLen;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(nx, ny);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font =
      '600 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${Math.round(value)} km/h`, cx, cy + 18);

    ctx.restore();
  },
};

const eventsOverlayPlugin = {
  id: "eventsOverlay",
  beforeDatasetsDraw(chart) {
    const cfg = chart?.options?.plugins?.eventsOverlay;
    if (!cfg || !cfg.enabled) return;
    const ca = chart.chartArea;
    if (!ca) return;
    const ctx = chart.ctx;
    if (!ctx) return;

    const events = Array.isArray(cfg.events) ? cfg.events : [];
    if (events.length === 0) return;

    const xScale = chart.scales?.x;
    if (!xScale) return;
    const xMin = Number.isFinite(xScale.min) ? xScale.min : null;
    const xMax = Number.isFinite(xScale.max) ? xScale.max : null;
    if (xMin == null || xMax == null || xMax <= xMin) return;

    ctx.save();
    // Ensure ranges are rendered behind the plotted data.
    ctx.globalCompositeOperation = "destination-over";

    const eventTypeFromSource = (source) => {
      const s = String(source || "").toUpperCase();
      if (!s) return "other";
      if (s.includes("LANE") && s.includes("CHANGE")) return "lane_change";
      if (s.includes("SPEED")) return "speeding";
      if (s.includes("BRAKE")) return "harsh_brake";
      if (s.includes("ACCEL")) return "harsh_accel";
      if (s.includes("TURN") || s.includes("YAW")) return "harsh_turn";
      return "other";
    };

    const stylesForEvent = (e) => {
      const type = eventTypeFromSource(e?.source);
      if (type === "lane_change") {
        const dir = Number(e?.direction);
        const isRight = dir === 1;
        const isLeft = dir === -1;
        return {
          rangeFill: isRight
            ? "rgba(34, 197, 94, 0.16)"
            : isLeft
            ? "rgba(239, 68, 68, 0.16)"
            : "rgba(251, 191, 36, 0.14)",
        };
      }
      if (type === "speeding") return { rangeFill: "rgba(236, 72, 153, 0.14)" };
      if (type === "harsh_brake")
        return { rangeFill: "rgba(239, 68, 68, 0.12)" };
      if (type === "harsh_accel")
        return { rangeFill: "rgba(34, 211, 238, 0.12)" };
      if (type === "harsh_turn")
        return { rangeFill: "rgba(168, 85, 247, 0.12)" };
      return { rangeFill: "rgba(148, 163, 184, 0.10)" };
    };

    for (const e of events) {
      const t = Number(e?.t);
      if (!Number.isFinite(t)) continue;

      const dur = Number(e?.durationSeconds);
      if (!Number.isFinite(dur) || dur <= 0) continue;

      const start = t;
      const end = t + dur;
      // Draw ranges that intersect the visible window.
      if (end < xMin || start > xMax) continue;

      const startClamped = Math.max(xMin, start);
      const endClamped = Math.min(xMax, end);
      if (endClamped <= startClamped) continue;

      const x1 = xScale.getPixelForValue(startClamped);
      const x2 = xScale.getPixelForValue(endClamped);
      if (!Number.isFinite(x1) || !Number.isFinite(x2)) continue;

      const left = Math.max(ca.left, Math.min(x1, x2));
      const right = Math.min(ca.right, Math.max(x1, x2));
      const w = right - left;
      if (w <= 1) continue;

      const st = stylesForEvent(e);
      ctx.fillStyle = st.rangeFill;
      ctx.fillRect(left, ca.top, w, ca.bottom - ca.top);
    }

    ctx.restore();
  },
  afterDatasetsDraw(chart) {
    const cfg = chart?.options?.plugins?.eventsOverlay;
    if (!cfg || !cfg.enabled) return;
    const ca = chart.chartArea;
    if (!ca) return;
    const ctx = chart.ctx;
    if (!ctx) return;

    const showLabels = Boolean(cfg.showLabels);

    const events = Array.isArray(cfg.events) ? cfg.events : [];
    if (events.length === 0) return;

    const xScale = chart.scales?.x;
    if (!xScale) return;
    const xMin = Number.isFinite(xScale.min) ? xScale.min : null;
    const xMax = Number.isFinite(xScale.max) ? xScale.max : null;
    if (xMin == null || xMax == null || xMax <= xMin) return;

    const maxLabels = Number.isFinite(cfg.maxLabels) ? cfg.maxLabels : 12;
    const labelLen = Number.isFinite(cfg.labelMaxLen) ? cfg.labelMaxLen : 28;

    const within = [];
    for (const e of events) {
      const t = Number(e?.t);
      if (!Number.isFinite(t)) continue;
      if (t < xMin || t > xMax) continue;
      within.push(e);
    }
    if (within.length === 0) return;

    const step =
      within.length > maxLabels ? Math.ceil(within.length / maxLabels) : 1;

    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = 1;

    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font =
      '600 11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    const eventTypeFromSource = (source) => {
      const s = String(source || "").toUpperCase();
      if (!s) return "other";
      if (s.includes("LANE") && s.includes("CHANGE")) return "lane_change";
      if (s.includes("SPEED")) return "speeding";
      if (s.includes("BRAKE")) return "harsh_brake";
      if (s.includes("ACCEL")) return "harsh_accel";
      if (s.includes("TURN") || s.includes("YAW")) return "harsh_turn";
      return "other";
    };

    const stylesForEvent = (e) => {
      const type = eventTypeFromSource(e?.source);
      if (type === "lane_change") {
        const dir = Number(e?.direction);
        const isRight = dir === 1;
        const isLeft = dir === -1;
        return {
          lineStroke: isRight
            ? "rgba(34, 197, 94, 0.55)"
            : isLeft
            ? "rgba(239, 68, 68, 0.55)"
            : "rgba(251, 191, 36, 0.55)",
        };
      }
      if (type === "speeding")
        return { lineStroke: "rgba(236, 72, 153, 0.60)" };
      if (type === "harsh_brake")
        return { lineStroke: "rgba(239, 68, 68, 0.60)" };
      if (type === "harsh_accel")
        return { lineStroke: "rgba(34, 211, 238, 0.60)" };
      if (type === "harsh_turn")
        return { lineStroke: "rgba(168, 85, 247, 0.60)" };
      return { lineStroke: "rgba(148, 163, 184, 0.55)" };
    };

    for (let i = 0; i < within.length; i += step) {
      const e = within[i];
      const t = Number(e?.t);
      const x = xScale.getPixelForValue(t);
      if (!Number.isFinite(x)) continue;
      if (x < ca.left - 1 || x > ca.right + 1) continue;

      // Speeding ranges are rendered as shaded bands. Avoid drawing a start line
      // for them, so the overlay is just the translucent range.
      const dur = Number(e?.durationSeconds);
      const type = eventTypeFromSource(e?.source);
      if (type === "speeding" && Number.isFinite(dur) && dur > 0) continue;

      const st = stylesForEvent(e);
      const lineStroke = st.lineStroke;

      ctx.save();
      ctx.strokeStyle = lineStroke;
      ctx.beginPath();
      ctx.moveTo(x, ca.top);
      ctx.lineTo(x, ca.bottom);
      ctx.stroke();
      ctx.restore();

      if (!showLabels) continue;

      const raw = String(e?.label ?? "");
      const short =
        raw.length > labelLen
          ? `${raw.slice(0, Math.max(1, labelLen - 1))}…`
          : raw;
      const y = ca.top + 2;
      const padX = 3;
      const maxW = Math.max(10, ca.right - x - 6);

      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      const w = Math.min(maxW, ctx.measureText(short).width + padX * 2);
      ctx.fillRect(x + 2, y, w, 14);
      ctx.restore();

      ctx.fillText(short, x + 2 + padX, y + 1);
    }

    ctx.restore();
  },
};

try {
  if (typeof Chart !== "undefined" && Chart?.register) {
    Chart.register(odometerOverlayPlugin);
    Chart.register(eventsOverlayPlugin);
  }
} catch {
  // ignore
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

  return new Chart(canvasEl.getContext("2d"), {
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
        {
          label: "Series 2",
          data: [],
          borderColor: "#f59e0b",
          backgroundColor: "rgba(245,158,11,0.10)",
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.15,
          hidden: true,
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
        odometerOverlay: { enabled: false, max: 160 },
        eventsOverlay: {
          enabled: true,
          events: [],
          maxLabels: 12,
          showLabels: false,
          labelMaxLen: 28,
        },
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
      applyAccelFilter: true,
      emphasizeZeroLine: true,
      symmetricAroundZero: true,
    },
    {
      key: "accel_y",
      title: "RAW_ACCELEROMETERS (y)",
      subtitle: "Acceleration (Gs)",
      kind: "accelerometers",
      axis: "y",
      applyAccelFilter: true,
      emphasizeZeroLine: true,
      symmetricAroundZero: true,
    },
    {
      key: "accel_z",
      title: "RAW_ACCELEROMETERS (z)",
      subtitle: "Acceleration (Gs)",
      kind: "accelerometers",
      axis: "z",
      applyAccelFilter: true,
      emphasizeZeroLine: true,
      symmetricAroundZero: true,
    },
    {
      key: "roll",
      title: "RAW_ACCELEROMETERS (roll)",
      subtitle: "Orientation (deg)",
      kind: "accelerometers",
      axis: "roll",
      applyAccelFilter: false,
      emphasizeZeroLine: false,
      symmetricAroundZero: false,
    },
    {
      key: "pitch",
      title: "RAW_ACCELEROMETERS (pitch)",
      subtitle: "Orientation (deg)",
      kind: "accelerometers",
      axis: "pitch",
      applyAccelFilter: false,
      emphasizeZeroLine: false,
      symmetricAroundZero: true,
    },
    {
      key: "yaw",
      title: "RAW_ACCELEROMETERS (yaw)",
      subtitle: "Orientation (deg)",
      kind: "accelerometers",
      axis: "yaw",
      applyAccelFilter: false,
      emphasizeZeroLine: false,
      symmetricAroundZero: false,
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

    if (spec.kind === "accelerometers" && spec.emphasizeZeroLine !== false) {
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

  updateVideoTripOverlay();

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

  // Use a single, authoritative offset for the whole trip.
  // offsetSeconds = (data_start - video_start)
  // Therefore: t_video = t_data + offsetSeconds
  const offsetSecondsBase = Number(trip.offsetSeconds) || 0;
  const overrideSeconds = getSyncOverrideSeconds(tripId);
  const offsetSeconds =
    overrideSeconds == null ? offsetSecondsBase : Number(overrideSeconds) || 0;

  // Determine which per-trip series files exist to avoid noisy network errors
  // when optional files (e.g. PROC_OPENSTREETMAP_DATA) are missing.
  state.availableSeriesFiles = null;
  try {
    const filesUrl = `/api/trips/${encodeURIComponent(tripId)}/series_files`;
    const filesRes = await fetch(filesUrl);
    if (filesRes.ok) {
      const filesJson = await filesRes.json();
      const files = Array.isArray(filesJson?.files) ? filesJson.files : [];
      state.availableSeriesFiles = new Set(files.map((s) => String(s)));
    }
  } catch {
    state.availableSeriesFiles = null;
  }

  // Load each panel data
  for (const p of state.panels) {
    if (p.spec.kind === "computed") {
      p.t = [];
      p.v = [];
      p.yMinSmooth = undefined;
      p.yMaxSmooth = undefined;
      p.chart.data.datasets[0].label = p.spec.title;
      p.chart.data.datasets[0].data = [];
      p.chart.data.datasets[1].data = [];
      p.chart.update();
      continue;
    }
    if (p.spec.kind === "accelerometers") {
      const url = `/api/trips/${encodeURIComponent(
        tripId
      )}/accelerometers?axis=${encodeURIComponent(
        p.spec.axis
      )}&downsample=${encodeURIComponent(state.downsample)}`;
      const res = await fetch(url);
      if (!res.ok)
        throw new Error(`Failed to load accelerometers axis ${p.spec.axis}`);
      const json = await res.json();
      const tRaw = json.t || [];
      p.t = Array.isArray(tRaw)
        ? tRaw.map((tt) => {
            const n = Number(tt);
            return Number.isFinite(n) ? n + offsetSeconds : n;
          })
        : [];
      p.v = json.v || [];
      p.vRaw = Array.from(p.v);
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
      const tRaw = json.t || [];
      p.t = Array.isArray(tRaw)
        ? tRaw.map((tt) => {
            const n = Number(tt);
            return Number.isFinite(n) ? n + offsetSeconds : n;
          })
        : [];
      p.v = json.v || [];
    }

    if (p.spec.key === "gps_speed") {
      let vmax = 0;
      for (const vv of p.v) {
        const n = Number(vv);
        if (!Number.isFinite(n)) continue;
        if (n > vmax) vmax = n;
      }
      p.vMaxGlobal = vmax;

      // Track OSM speed limit max (if available) so we can scale the chart to
      // include both the real speed and the permitted speed.
      p.vMaxLimitGlobal = undefined;

      // Keep odometer scale aligned with trip max.
      if (p.chart?.options?.plugins?.odometerOverlay) {
        p.chart.options.plugins.odometerOverlay.max = Math.max(
          1,
          Math.ceil(vmax)
        );
      }

      // Overlay max speed (OSM) as a red line if available.
      // PROC_OPENSTREETMAP_DATA col=1 is "Current road maxspeed".
      const canLoadMaxSpeed =
        state.availableSeriesFiles == null ||
        state.availableSeriesFiles.has("PROC_OPENSTREETMAP_DATA");

      try {
        if (!canLoadMaxSpeed) {
          if (p.chart?.data?.datasets?.[2]) {
            p.chart.data.datasets[2].hidden = true;
            p.chart.data.datasets[2].data = [];
          }
          throw new Error(
            "PROC_OPENSTREETMAP_DATA not available for this trip"
          );
        }
        const limitUrl = `/api/trips/${encodeURIComponent(
          tripId
        )}/series?file=${encodeURIComponent(
          "PROC_OPENSTREETMAP_DATA"
        )}&col=${encodeURIComponent(1)}&downsample=${encodeURIComponent(
          state.downsample
        )}`;
        const limitRes = await fetch(limitUrl);
        if (limitRes.ok) {
          const limitJson = await limitRes.json();
          const t2 = Array.isArray(limitJson.t)
            ? limitJson.t.map((tt) => {
                const n = Number(tt);
                return Number.isFinite(n) ? n + offsetSeconds : n;
              })
            : [];
          const v2 = Array.isArray(limitJson.v) ? limitJson.v : [];

          if (
            p.chart?.data?.datasets?.[2] &&
            t2.length > 1 &&
            v2.length === t2.length
          ) {
            // Resample maxspeed onto gps_speed timestamps (p.t).
            // We use last-known maxspeed for each GPS time.
            let j = 0;
            let last = null;
            const maxSeries = p.t.map((tt) => {
              const tNum = Number(tt);
              while (j < t2.length && Number(t2[j]) <= tNum) {
                const vv = Number(v2[j]);
                if (Number.isFinite(vv)) last = vv;
                j++;
              }
              return { x: tNum, y: last };
            });

            // If we never found a finite value, hide the overlay.
            const hasAny = maxSeries.some((pt) => Number.isFinite(pt.y));
            if (hasAny) {
              let vmaxLimit = 0;
              for (const pt of maxSeries) {
                const n = Number(pt?.y);
                if (!Number.isFinite(n)) continue;
                if (n > vmaxLimit) vmaxLimit = n;
              }
              p.vMaxLimitGlobal = vmaxLimit;

              p.chart.data.datasets[2].hidden = false;
              p.chart.data.datasets[2].label = "Max speed";
              p.chart.data.datasets[2].borderColor = "#ef4444";
              p.chart.data.datasets[2].backgroundColor = "rgba(239,68,68,0.10)";
              p.chart.data.datasets[2].borderWidth = 1.5;
              p.chart.data.datasets[2].pointRadius = 0;
              p.chart.data.datasets[2].tension = 0;
              p.chart.data.datasets[2].data = maxSeries;
            } else {
              p.vMaxLimitGlobal = undefined;
              p.chart.data.datasets[2].hidden = true;
              p.chart.data.datasets[2].data = [];
            }
          } else if (p.chart?.data?.datasets?.[2]) {
            p.vMaxLimitGlobal = undefined;
            p.chart.data.datasets[2].hidden = true;
            p.chart.data.datasets[2].data = [];
          }
        } else if (p.chart?.data?.datasets?.[2]) {
          p.vMaxLimitGlobal = undefined;
          p.chart.data.datasets[2].hidden = true;
          p.chart.data.datasets[2].data = [];
        }
      } catch {
        p.vMaxLimitGlobal = undefined;
        if (p.chart?.data?.datasets?.[2]) {
          p.chart.data.datasets[2].hidden = true;
          p.chart.data.datasets[2].data = [];
        }
      }
    }

    p.chart.data.datasets[0].label = p.spec.title;
    p.chart.data.datasets[0].data = p.t.map((t, i) => ({ x: t, y: p.v[i] }));
    p.chart.data.datasets[1].data = [];
    // Keep dataset[2] for gps_speed overlay (max speed). Clear it for other panels.
    if (p.spec.key !== "gps_speed" && p.chart.data.datasets[2])
      p.chart.data.datasets[2].data = [];
    p.chart.update();
  }

  // Apply accelerometer smoothing overlays after data is loaded.
  applyAccelFilterToPanels();

  state.offsetSeconds = offsetSeconds;

  state.events = [];
  try {
    const eventsUrl = `/api/trips/${encodeURIComponent(
      tripId
    )}/events?filePrefix=${encodeURIComponent("")}`;
    const eventsRes = await fetch(eventsUrl);
    if (eventsRes.ok) {
      const eventsJson = await eventsRes.json();
      const raw = Array.isArray(eventsJson.events) ? eventsJson.events : [];
      state.events = raw
        .map((e) => {
          const t = Number(e?.t);
          return {
            ...e,
            t: Number.isFinite(t) ? t + offsetSeconds : e?.t,
          };
        })
        .sort((a, b) => Number(a?.t || 0) - Number(b?.t || 0));
    }
  } catch {
    state.events = [];
  }

  try {
    const speedingUrl = `/api/trips/${encodeURIComponent(
      tripId
    )}/evidence?kind=${encodeURIComponent(
      "speeding"
    )}&only_events=${encodeURIComponent("false")}&max_rows=0`;
    const speedingRes = await fetch(speedingUrl);
    if (speedingRes.ok) {
      const speedingJson = await speedingRes.json();
      const ranges = speedingEvidenceToRangeEvents(speedingJson, offsetSeconds);
      if (ranges.length) {
        state.events = state.events.concat(ranges);
        state.events.sort((a, b) => Number(a?.t || 0) - Number(b?.t || 0));
      }
    }
  } catch {
    // ignore
  }

  for (const p of state.panels) {
    if (!p?.chart?.options?.plugins?.eventsOverlay) continue;
    p.chart.options.plugins.eventsOverlay.events = state.events;
    p.chart.update("none");
  }

  // Load GPS track for the map
  state.gps = null;
  state.gpsRaw = null;
  try {
    const gpsUrl = `/api/trips/${encodeURIComponent(
      tripId
    )}/gps?downsample=${encodeURIComponent(state.downsample)}`;
    const gpsRes = await fetch(gpsUrl);
    if (gpsRes.ok) {
      const gpsJson = await gpsRes.json();
      const tShifted = Array.isArray(gpsJson.t)
        ? gpsJson.t.map((tt) => {
            const n = Number(tt);
            return Number.isFinite(n) ? n + offsetSeconds : n;
          })
        : [];
      state.gpsRaw = {
        t: tShifted,
        lat: gpsJson.lat || [],
        lon: gpsJson.lon || [],
      };
      const settings = gpsFilterSettingsFromUi();
      state.gps = applyGpsFilter(state.gpsRaw, settings);
      if (state.gps)
        setGpsTrackOnMap(state.gps.t, state.gps.lat, state.gps.lon);
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
    offsetSeconds: offsetSecondsBase,
  });
}

function updateCursor() {
  const tVideo = els.video.currentTime || 0;
  const tData = tVideo;

  updateVideoTimeOverlay();

  const w = Math.max(2, state.windowSeconds);
  for (const p of state.panels) {
    if (!p.t || p.t.length === 0) continue;
    const vForCursor =
      p.spec.kind === "accelerometers" && Array.isArray(p.vForCursor)
        ? p.vForCursor
        : p.v;
    const y = interpolatedY(p.t, vForCursor, tData);
    if (y == null) continue;

    if (p.spec.key === "gps_speed" && p.chart) {
      // Odometer overlay for RAW_GPS speed.
      p.chart.$odometerValue = y;
      if (p.chart.options?.plugins?.odometerOverlay) {
        p.chart.options.plugins.odometerOverlay.enabled = true;
        const vmax = Number(p.vMaxGlobal);
        p.chart.options.plugins.odometerOverlay.max = Number.isFinite(vmax)
          ? Math.max(1, Math.ceil(vmax))
          : 160;
      }

      // Fixed Y scale based on global max among real speed and permitted speed.
      const vmax = Number(p.vMaxGlobal);
      const vmaxLimit = Number(p.vMaxLimitGlobal);
      const ymaxBase = Math.max(
        1,
        Number.isFinite(vmax) ? Math.ceil(vmax) : 0,
        Number.isFinite(vmaxLimit) ? Math.ceil(vmaxLimit) : 0
      );
      p.chart.options.scales.y.min = 0;
      p.chart.options.scales.y.max = ymaxBase > 0 ? ymaxBase : 160;
      // Disable window-based auto-scaling for this plot.
      p.yMinSmooth = undefined;
      p.yMaxSmooth = undefined;
    }

    // Use exact video-time for x so the cursor moves smoothly even if sampling is coarse.
    p.chart.data.datasets[1].data = [{ x: tData, y }];
    p.chart.options.scales.x.min = tData - w / 2;
    p.chart.options.scales.x.max = tData + w / 2;

    if (p.spec.key === "gps_speed") {
      p.chart.update("none");
      continue;
    }

    let mm = windowMinMax(p.t, p.v, tData - w / 2, tData + w / 2);
    if (
      p.spec.kind === "accelerometers" &&
      Array.isArray(p.vRaw) &&
      Array.isArray(p.vSmooth) &&
      p.vRaw.length === p.t.length &&
      p.vSmooth.length === p.t.length
    ) {
      const mmRaw = windowMinMax(p.t, p.vRaw, tData - w / 2, tData + w / 2);
      const mmSm = windowMinMax(p.t, p.vSmooth, tData - w / 2, tData + w / 2);
      if (mmRaw && mmSm) {
        mm = {
          min: Math.min(mmRaw.min, mmSm.min),
          max: Math.max(mmRaw.max, mmSm.max),
        };
      } else {
        mm = mmRaw || mmSm || mm;
      }
    }
    if (mm) {
      const range = mm.max - mm.min;
      const pad = range * 0.08;
      let targetMin = mm.min - pad;
      let targetMax = mm.max + pad;

      if (
        p.spec.kind === "accelerometers" &&
        p.spec.symmetricAroundZero !== false
      ) {
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

      if (p.spec.key === "gps_speed") {
        // RAW_GPS speed: avoid over-zoom when the variation is tiny.
        // Keep a minimum Y-range of 20 Km/h so small fluctuations don't look like spikes.
        const minSpan = 20;
        if (Number.isFinite(targetMin) && Number.isFinite(targetMax)) {
          const span = targetMax - targetMin;
          if (Number.isFinite(span) && span > 0 && span < minSpan) {
            const mid = (targetMin + targetMax) / 2;
            targetMin = mid - minSpan / 2;
            targetMax = mid + minSpan / 2;
          }
        }
        // Speed can't be negative; keep baseline at 0.
        if (Number.isFinite(targetMin)) targetMin = Math.max(0, targetMin);
        if (Number.isFinite(targetMax) && targetMax < minSpan)
          targetMax = minSpan;
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
  if (els.sidebarToggle) {
    els.sidebarToggle.addEventListener("click", () => {
      const main = document.querySelector?.("main.main");
      const collapsed = !!main?.classList?.contains("sidebarCollapsed");
      const next = !collapsed;
      setSidebarCollapsed(next);
      savePersistedState({ sidebarCollapsed: next });
    });
  }

  if (els.tableDrawerToggle) {
    els.tableDrawerToggle.addEventListener("click", () => {
      const isOpen =
        els.tableDrawerToggle?.getAttribute("aria-expanded") === "true";
      const next = !isOpen;
      setTableDrawerOpen(next);
      savePersistedState({ tableOpen: next });
      if (next && els.tableWrap && !els.tableWrap.innerHTML) {
        loadTableData().catch((e) => renderTableError(e));
      }
    });
  }

  if (els.tableLoad) {
    els.tableLoad.addEventListener("click", () => {
      setTableDrawerOpen(true);
      savePersistedState({ tableOpen: true });
      loadTableData().catch((e) => renderTableError(e));
    });
  }

  if (els.tableOpenTab) {
    els.tableOpenTab.addEventListener("click", () => {
      openTableInNewTab();
    });
  }

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

  // Keep time overlay updated even when user interacts with native controls.
  if (els.video) {
    els.video.addEventListener("timeupdate", updateVideoTimeOverlay);
    els.video.addEventListener("seeked", updateVideoTimeOverlay);
    els.video.addEventListener("loadedmetadata", updateVideoTimeOverlay);
    els.video.addEventListener("emptied", updateVideoTimeOverlay);
  }

  els.driverSelect.addEventListener("change", () => {
    const driver = els.driverSelect.value;
    savePersistedState({ driver, videoTime: 0 });
    renderTripOptionsForDriver(driver, null);
    savePersistedState({ tripId: els.tripSelect.value, videoTime: 0 });
    updateVideoTripOverlay();
    loadTripData().catch((e) => renderMetaError(e));
  });

  els.tripSelect.addEventListener("change", () => {
    savePersistedState({ tripId: els.tripSelect.value, videoTime: 0 });
    updateVideoTripOverlay();
    loadTripData().catch((e) => renderMetaError(e));
  });

  els.reloadBtn.addEventListener("click", () => {
    loadTripData().catch((e) => renderMetaError(e));
  });

  const applyGpsFilterAndRedraw = () => {
    const s = gpsFilterSettingsFromUi();
    savePersistedState({
      gpsFilter: s.kind,
      gpsResample10Hz: s.resample10Hz,
      gpsMaWindow: s.maWindow,
      gpsKalmanSigmaA: s.sigmaA,
      gpsKalmanSigmaZ: s.sigmaZ,
    });
    if (!state.gpsRaw) return;
    state.gps = applyGpsFilter(state.gpsRaw, s);
    if (state.gps) setGpsTrackOnMap(state.gps.t, state.gps.lat, state.gps.lon);
    // Refresh cursor-derived elements (marker + computed panels)
    updateCursor();
  };

  if (els.gpsFilter)
    els.gpsFilter.addEventListener("change", applyGpsFilterAndRedraw);
  if (els.gpsResample10Hz)
    els.gpsResample10Hz.addEventListener("change", applyGpsFilterAndRedraw);
  if (els.gpsMaWindow)
    els.gpsMaWindow.addEventListener("change", applyGpsFilterAndRedraw);
  if (els.gpsKalmanSigmaA)
    els.gpsKalmanSigmaA.addEventListener("change", applyGpsFilterAndRedraw);
  if (els.gpsKalmanSigmaZ)
    els.gpsKalmanSigmaZ.addEventListener("change", applyGpsFilterAndRedraw);

  const applyAccelFilterAndRedraw = () => {
    const s = accelFilterSettingsFromUi();
    savePersistedState({
      accelFilter: s.kind,
      accelMaWindow: s.maWindow,
      accelKalmanSigmaA: s.sigmaA,
      accelKalmanSigmaZ: s.sigmaZ,
    });
    applyAccelFilterToPanels();
  };

  if (els.accelFilter)
    els.accelFilter.addEventListener("change", applyAccelFilterAndRedraw);
  if (els.accelMaWindow)
    els.accelMaWindow.addEventListener("change", applyAccelFilterAndRedraw);
  if (els.accelKalmanSigmaA)
    els.accelKalmanSigmaA.addEventListener("change", applyAccelFilterAndRedraw);
  if (els.accelKalmanSigmaZ)
    els.accelKalmanSigmaZ.addEventListener("change", applyAccelFilterAndRedraw);

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

  const query = parseQuery();

  // Restore persisted values into inputs before initial load
  const persisted = loadPersistedState();
  if (persisted) {
    if (typeof persisted.sidebarCollapsed === "boolean")
      setSidebarCollapsed(persisted.sidebarCollapsed);
    if (typeof persisted.tableOpen === "boolean")
      setTableDrawerOpen(persisted.tableOpen);
    if (typeof persisted.windowSeconds === "number")
      els.windowSeconds.value = String(persisted.windowSeconds);
    if (typeof persisted.downsample === "number")
      els.downsample.value = String(persisted.downsample);
    if (typeof persisted.gpsFilter === "string" && els.gpsFilter)
      els.gpsFilter.value = persisted.gpsFilter;
    if (typeof persisted.gpsResample10Hz === "boolean" && els.gpsResample10Hz)
      els.gpsResample10Hz.checked = persisted.gpsResample10Hz;
    if (typeof persisted.gpsMaWindow === "number" && els.gpsMaWindow)
      els.gpsMaWindow.value = String(persisted.gpsMaWindow);
    if (typeof persisted.gpsKalmanSigmaA === "number" && els.gpsKalmanSigmaA)
      els.gpsKalmanSigmaA.value = String(persisted.gpsKalmanSigmaA);
    if (typeof persisted.gpsKalmanSigmaZ === "number" && els.gpsKalmanSigmaZ)
      els.gpsKalmanSigmaZ.value = String(persisted.gpsKalmanSigmaZ);

    if (typeof persisted.accelFilter === "string" && els.accelFilter)
      els.accelFilter.value = persisted.accelFilter;
    if (typeof persisted.accelMaWindow === "number" && els.accelMaWindow)
      els.accelMaWindow.value = String(persisted.accelMaWindow);
    if (
      typeof persisted.accelKalmanSigmaA === "number" &&
      els.accelKalmanSigmaA
    )
      els.accelKalmanSigmaA.value = String(persisted.accelKalmanSigmaA);
    if (
      typeof persisted.accelKalmanSigmaZ === "number" &&
      els.accelKalmanSigmaZ
    )
      els.accelKalmanSigmaZ.value = String(persisted.accelKalmanSigmaZ);

    if (typeof persisted.tableFile === "string" && els.tableFile)
      els.tableFile.value = persisted.tableFile;
    if (typeof persisted.tableDownsample === "number" && els.tableDownsample)
      els.tableDownsample.value = String(persisted.tableDownsample);
    if (typeof persisted.tableOffset === "number" && els.tableOffset)
      els.tableOffset.value = String(persisted.tableOffset);
    if (typeof persisted.tableLimit === "number" && els.tableLimit)
      els.tableLimit.value = String(persisted.tableLimit);
  }

  await loadTrips();

  // Allow deep-linking to a specific trip from URL.
  if (query.tripId && byId(query.tripId)) {
    const driver = driverFromTripId(query.tripId);
    if (driver && els.driverSelect && els.driverSelect.value !== driver) {
      els.driverSelect.value = driver;
      renderTripOptionsForDriver(driver, query.tripId);
    }
    if (els.tripSelect) {
      els.tripSelect.value = query.tripId;
      savePersistedState({ driver, tripId: query.tripId, videoTime: 0 });
    }
  }

  await loadTripData();
  seekVideoToRequestedTime(query);

  // If the video is already playing when the page loads, start the loop.
  if (!els.video.paused) startSmoothLoop();
}

main().catch((e) => {
  renderMetaError(e);
});
