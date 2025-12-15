let state = {
  trips: [],
  charts: {},
};

function byId(id) {
  return state.trips.find((t) => t.id === id) || null;
}

function driverFromTripId(tripId) {
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

function safeNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function els() {
  return {
    driverA: document.getElementById("cmpDriverA"),
    tripA: document.getElementById("cmpTripA"),
    allTripsA: document.getElementById("cmpAllTripsA"),
    metaA: document.getElementById("cmpMetaA"),

    driverB: document.getElementById("cmpDriverB"),
    tripB: document.getElementById("cmpTripB"),
    allTripsB: document.getElementById("cmpAllTripsB"),
    metaB: document.getElementById("cmpMetaB"),

    downsample: document.getElementById("cmpDownsample"),
    maxPoints: document.getElementById("cmpMaxPoints"),
    run: document.getElementById("cmpRun"),

    summary: document.getElementById("cmpSummary"),
    error: document.getElementById("cmpError"),

    cSpeed: document.getElementById("cmpChartSpeed"),
    cAx: document.getElementById("cmpChartAccelX"),
    cAy: document.getElementById("cmpChartAccelY"),
    cJerk: document.getElementById("cmpChartJerk"),
    cYawRate: document.getElementById("cmpChartYawRate"),
  };
}

function destroyCharts() {
  for (const k of Object.keys(state.charts)) {
    try {
      state.charts[k].destroy();
    } catch {
      // ignore
    }
  }
  state.charts = {};
}

function buildCompareChart(canvas, title, unit) {
  const ctx = canvas.getContext("2d");
  const chart = new Chart(ctx, {
    type: "line",
    data: {
      datasets: [
        {
          label: "A",
          data: [],
          borderColor: "rgba(110,168,254,0.95)",
          backgroundColor: "rgba(110,168,254,0.20)",
          tension: 0.25,
          pointRadius: 0,
          borderWidth: 2,
          fill: false,
        },
        {
          label: "B",
          data: [],
          borderColor: "rgba(255,124,107,0.95)",
          backgroundColor: "rgba(255,124,107,0.18)",
          tension: 0.25,
          pointRadius: 0,
          borderWidth: 2,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: true },
        title: {
          display: false,
          text: title || "",
        },
        tooltip: {
          callbacks: {
            title: (items) => {
              const x = items?.[0]?.raw?.x;
              return x != null ? `${x}` : "";
            },
            label: (item) => {
              const y = item?.raw?.y;
              const lbl = item?.dataset?.label || "";
              if (typeof y !== "number") return lbl;
              return `${lbl}: ${y.toFixed(4)}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          title: {
            display: true,
            text: unit ? unit : "",
          },
          grid: { color: "rgba(255,255,255,0.06)" },
          ticks: { color: "rgba(230,232,239,0.85)" },
        },
        y: {
          title: { display: true, text: "Probability" },
          grid: { color: "rgba(255,255,255,0.06)" },
          ticks: { color: "rgba(230,232,239,0.85)" },
          beginAtZero: true,
        },
      },
    },
  });

  return chart;
}

function ensureCharts() {
  const e = els();
  destroyCharts();
  state.charts.speed = buildCompareChart(
    e.cSpeed,
    "Speed distribution",
    "km/h"
  );
  state.charts.ax = buildCompareChart(e.cAx, "Longitudinal acceleration", "Gs");
  state.charts.ay = buildCompareChart(e.cAy, "Lateral acceleration", "Gs");
  state.charts.jerk = buildCompareChart(e.cJerk, "Jerk magnitude", "Gs/s");
  state.charts.yawRate = buildCompareChart(e.cYawRate, "Yaw rate", "deg/s");
}

function setError(msg) {
  const e = els();
  if (!msg) {
    e.error.hidden = true;
    e.error.textContent = "";
    return;
  }
  e.error.hidden = false;
  e.error.textContent = msg;
}

function setSummary(html) {
  const e = els();
  e.summary.innerHTML = html || "";
}

function renderDriverOptions(selectEl, drivers, selected) {
  selectEl.innerHTML = "";
  for (const d of drivers) {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    selectEl.appendChild(opt);
  }
  if (selected && drivers.includes(selected)) selectEl.value = selected;
  else if (drivers.length) selectEl.value = drivers[0];
}

function renderTripOptionsForDriver(selectEl, driver, preferredTripId) {
  const list = state.trips.filter((t) => driverFromTripId(t.id) === driver);
  selectEl.innerHTML = "";
  for (const t of list) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = tripLabelFromTripId(t.id);
    selectEl.appendChild(opt);
  }
  if (preferredTripId && byId(preferredTripId))
    selectEl.value = preferredTripId;
  else if (list.length) selectEl.value = list[0].id;
}

function tripIdsForProfile(kind) {
  const e = els();
  const driverSel = kind === "A" ? e.driverA : e.driverB;
  const tripSel = kind === "A" ? e.tripA : e.tripB;
  const allTrips = kind === "A" ? e.allTripsA : e.allTripsB;

  const driver = driverSel.value;
  if (!driver) return [];
  if (allTrips.checked) {
    return state.trips
      .filter((t) => driverFromTripId(t.id) === driver)
      .map((t) => t.id);
  }
  return tripSel.value ? [tripSel.value] : [];
}

async function fetchGpsSpeed(tripId, downsample) {
  const url = `/api/trips/${encodeURIComponent(
    tripId
  )}/gps?downsample=${encodeURIComponent(downsample)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load GPS for ${tripId}`);
  const json = await res.json();
  return { t: json.t || [], speed: json.speed || [] };
}

async function fetchAccelAxis(tripId, axis, downsample) {
  const url = `/api/trips/${encodeURIComponent(
    tripId
  )}/accelerometers?axis=${encodeURIComponent(
    axis
  )}&downsample=${encodeURIComponent(downsample)}`;
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`Failed to load accelerometers ${axis} for ${tripId}`);
  const json = await res.json();
  return { t: json.t || [], v: json.v || [] };
}

function sampleToMaxPoints(t, v, maxPoints) {
  const n = Math.min(t.length, v.length);
  if (n <= 0) return { t: [], v: [] };
  if (n <= maxPoints) return { t: t.slice(0, n), v: v.slice(0, n) };

  const stride = Math.ceil(n / maxPoints);
  const tt = [];
  const vv = [];
  for (let i = 0; i < n; i += stride) {
    tt.push(t[i]);
    vv.push(v[i]);
  }
  return { t: tt, v: vv };
}

function concatNumeric(arrays, maxLen) {
  const out = [];
  for (const a of arrays) {
    if (!a) continue;
    for (const x of a) {
      const n = Number(x);
      if (!Number.isFinite(n)) continue;
      out.push(n);
      if (out.length >= maxLen) return out;
    }
  }
  return out;
}

function histogramDensity(values, binCount, minV, maxV) {
  const vals = values.filter((n) => Number.isFinite(n));
  if (vals.length === 0) return { x: [], y: [] };

  let min = minV;
  let max = maxV;

  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    min = Math.min(...vals);
    max = Math.max(...vals);
    if (min === max) {
      min -= 1;
      max += 1;
    }
  }

  const bins = Math.max(5, Math.floor(binCount));
  const width = (max - min) / bins;
  const counts = new Array(bins).fill(0);

  for (const v of vals) {
    const idx = clamp(Math.floor((v - min) / width), 0, bins - 1);
    counts[idx] += 1;
  }

  const total = vals.length;
  const x = [];
  const y = [];
  for (let i = 0; i < bins; i++) {
    const center = min + (i + 0.5) * width;
    x.push(center);
    y.push(counts[i] / total);
  }

  return { x, y };
}

function setChart(chart, distA, distB) {
  chart.data.datasets[0].data = distA.x.map((x, i) => ({ x, y: distA.y[i] }));
  chart.data.datasets[1].data = distB.x.map((x, i) => ({ x, y: distB.y[i] }));
  chart.update();
}

function meanStd(values) {
  const vals = values.filter((n) => Number.isFinite(n));
  const n = vals.length;
  if (!n) return { mean: NaN, std: NaN };
  let s = 0;
  for (const v of vals) s += v;
  const mean = s / n;
  let ss = 0;
  for (const v of vals) {
    const d = v - mean;
    ss += d * d;
  }
  const std = Math.sqrt(ss / n);
  return { mean, std };
}

function percentile(values, p) {
  const vals = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!vals.length) return NaN;
  const pp = clamp(p, 0, 100) / 100;
  const idx = (vals.length - 1) * pp;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return vals[lo];
  const w = idx - lo;
  return vals[lo] * (1 - w) + vals[hi] * w;
}

function computeJerkMagnitude(t, ax, ay, az) {
  const n = Math.min(t.length, ax.length, ay.length, az.length);
  if (n < 3) return [];
  const out = [];
  for (let i = 1; i < n; i++) {
    const dt = Number(t[i]) - Number(t[i - 1]);
    if (!Number.isFinite(dt) || dt <= 0) continue;
    const a1 = Math.sqrt(
      Number(ax[i - 1]) * Number(ax[i - 1]) +
        Number(ay[i - 1]) * Number(ay[i - 1]) +
        Number(az[i - 1]) * Number(az[i - 1])
    );
    const a2 = Math.sqrt(
      Number(ax[i]) * Number(ax[i]) +
        Number(ay[i]) * Number(ay[i]) +
        Number(az[i]) * Number(az[i])
    );
    if (!Number.isFinite(a1) || !Number.isFinite(a2)) continue;
    out.push((a2 - a1) / dt);
  }
  return out;
}

function computeYawRate(t, yaw) {
  const n = Math.min(t.length, yaw.length);
  if (n < 3) return [];
  const out = [];
  for (let i = 1; i < n; i++) {
    const dt = Number(t[i]) - Number(t[i - 1]);
    if (!Number.isFinite(dt) || dt <= 0) continue;
    const dy = Number(yaw[i]) - Number(yaw[i - 1]);
    if (!Number.isFinite(dy)) continue;
    out.push(dy / dt);
  }
  return out;
}

async function loadTrips() {
  const res = await fetch("/api/trips");
  if (!res.ok) throw new Error("Failed to load trips");
  const json = await res.json();
  state.trips = Array.isArray(json.trips) ? json.trips : [];
}

function syncPickers() {
  const e = els();
  const drivers = uniqueSorted(
    state.trips.map((t) => driverFromTripId(t.id)).filter(Boolean)
  );

  renderDriverOptions(e.driverA, drivers, drivers[0] || "");
  renderDriverOptions(e.driverB, drivers, drivers[1] || drivers[0] || "");

  renderTripOptionsForDriver(e.tripA, e.driverA.value, "");
  renderTripOptionsForDriver(e.tripB, e.driverB.value, "");
}

function attachEvents() {
  const e = els();
  e.driverA.addEventListener("change", () => {
    renderTripOptionsForDriver(e.tripA, e.driverA.value, "");
  });
  e.driverB.addEventListener("change", () => {
    renderTripOptionsForDriver(e.tripB, e.driverB.value, "");
  });

  e.run.addEventListener("click", () => {
    runCompare().catch((err) => {
      setError(String(err?.message || err));
    });
  });
}

function setPickerMeta(kind, tripIds) {
  const e = els();
  const metaEl = kind === "A" ? e.metaA : e.metaB;
  const driver = kind === "A" ? e.driverA.value : e.driverB.value;
  metaEl.textContent = `${driver} · ${tripIds.length} trip(s)`;
}

async function runCompare() {
  const e = els();
  setError("Loading…");
  ensureCharts();

  const downsample = clamp(
    Math.floor(safeNumber(e.downsample.value, 10)),
    1,
    1000
  );
  const maxPoints = clamp(
    Math.floor(safeNumber(e.maxPoints.value, 60000)),
    500,
    500000
  );

  const tripIdsA = tripIdsForProfile("A");
  const tripIdsB = tripIdsForProfile("B");
  if (tripIdsA.length === 0) throw new Error("Profile A has no trips selected");
  if (tripIdsB.length === 0) throw new Error("Profile B has no trips selected");

  setPickerMeta("A", tripIdsA);
  setPickerMeta("B", tripIdsB);

  setSummary(
    `<div class="metaPanel"><div class="metaTitle">Comparison</div><div class="metaGrid">` +
      `<div class="metaRow"><div class="metaLabel">Downsample</div><div class="metaValue"><code>${downsample}</code></div></div>` +
      `<div class="metaRow"><div class="metaLabel">Max points (cap)</div><div class="metaValue"><code>${maxPoints}</code></div></div>` +
      `</div></div>`
  );

  const diag = {
    speedA: 0,
    speedB: 0,
    axA: 0,
    axB: 0,
    ayA: 0,
    ayB: 0,
    jerkA: 0,
    jerkB: 0,
    yawRateA: 0,
    yawRateB: 0,
  };

  const speedA = [];
  const speedB = [];

  for (const id of tripIdsA) {
    const gps = await fetchGpsSpeed(id, downsample);
    const sampled = sampleToMaxPoints(
      gps.t,
      gps.speed,
      Math.ceil(maxPoints / tripIdsA.length)
    );
    speedA.push(sampled.v);
    diag.speedA += sampled.v.length;
  }
  for (const id of tripIdsB) {
    const gps = await fetchGpsSpeed(id, downsample);
    const sampled = sampleToMaxPoints(
      gps.t,
      gps.speed,
      Math.ceil(maxPoints / tripIdsB.length)
    );
    speedB.push(sampled.v);
    diag.speedB += sampled.v.length;
  }

  const speedValsA = concatNumeric(speedA, maxPoints);
  const speedValsB = concatNumeric(speedB, maxPoints);

  const speedMin = Math.min(
    percentile(speedValsA, 0.5),
    percentile(speedValsB, 0.5)
  );
  const speedMax = Math.max(
    percentile(speedValsA, 99.5),
    percentile(speedValsB, 99.5)
  );

  setChart(
    state.charts.speed,
    histogramDensity(speedValsA, 50, speedMin, speedMax),
    histogramDensity(speedValsB, 50, speedMin, speedMax)
  );

  const axA = [];
  const axB = [];
  const ayA = [];
  const ayB = [];
  const ax3A = [];
  const ay3A = [];
  const az3A = [];
  const axTA = [];
  const yawTA = [];
  const yawVA = [];

  const ax3B = [];
  const ay3B = [];
  const az3B = [];
  const axTB = [];
  const yawTB = [];
  const yawVB = [];

  for (const id of tripIdsA) {
    const x = await fetchAccelAxis(id, "x_kf", downsample);
    const y = await fetchAccelAxis(id, "y_kf", downsample);
    const z = await fetchAccelAxis(id, "z_kf", downsample);
    const yaw = await fetchAccelAxis(id, "yaw", downsample);

    const budget = Math.ceil(maxPoints / tripIdsA.length);
    const sx = sampleToMaxPoints(x.t, x.v, budget);
    const sy = sampleToMaxPoints(y.t, y.v, budget);
    const sz = sampleToMaxPoints(z.t, z.v, budget);
    const syaw = sampleToMaxPoints(yaw.t, yaw.v, budget);

    axA.push(sx.v);
    ayA.push(sy.v);

    ax3A.push(sx.v);
    ay3A.push(sy.v);
    az3A.push(sz.v);

    axTA.push(sx.t);

    yawTA.push(syaw.t);
    yawVA.push(syaw.v);
  }

  for (const id of tripIdsB) {
    const x = await fetchAccelAxis(id, "x_kf", downsample);
    const y = await fetchAccelAxis(id, "y_kf", downsample);
    const z = await fetchAccelAxis(id, "z_kf", downsample);
    const yaw = await fetchAccelAxis(id, "yaw", downsample);

    const budget = Math.ceil(maxPoints / tripIdsB.length);
    const sx = sampleToMaxPoints(x.t, x.v, budget);
    const sy = sampleToMaxPoints(y.t, y.v, budget);
    const sz = sampleToMaxPoints(z.t, z.v, budget);
    const syaw = sampleToMaxPoints(yaw.t, yaw.v, budget);

    axB.push(sx.v);
    ayB.push(sy.v);

    ax3B.push(sx.v);
    ay3B.push(sy.v);
    az3B.push(sz.v);

    axTB.push(sx.t);

    yawTB.push(syaw.t);
    yawVB.push(syaw.v);
  }

  const axValsA = concatNumeric(axA, maxPoints);
  const axValsB = concatNumeric(axB, maxPoints);
  const ayValsA = concatNumeric(ayA, maxPoints);
  const ayValsB = concatNumeric(ayB, maxPoints);

  diag.axA = axValsA.length;
  diag.axB = axValsB.length;
  diag.ayA = ayValsA.length;
  diag.ayB = ayValsB.length;

  const axMin = Math.min(percentile(axValsA, 0.5), percentile(axValsB, 0.5));
  const axMax = Math.max(percentile(axValsA, 99.5), percentile(axValsB, 99.5));
  const ayMin = Math.min(percentile(ayValsA, 0.5), percentile(ayValsB, 0.5));
  const ayMax = Math.max(percentile(ayValsA, 99.5), percentile(ayValsB, 99.5));

  setChart(
    state.charts.ax,
    histogramDensity(axValsA, 70, axMin, axMax),
    histogramDensity(axValsB, 70, axMin, axMax)
  );

  setChart(
    state.charts.ay,
    histogramDensity(ayValsA, 70, ayMin, ayMax),
    histogramDensity(ayValsB, 70, ayMin, ayMax)
  );

  const jerkValsA = [];
  for (let i = 0; i < ax3A.length; i++) {
    const t = axTA[i] || [];
    const j = computeJerkMagnitude(
      t,
      ax3A[i] || [],
      ay3A[i] || [],
      az3A[i] || []
    );
    for (const v of j) jerkValsA.push(v);
    if (jerkValsA.length >= maxPoints) break;
  }

  diag.jerkA = jerkValsA.length;

  const jerkValsB = [];
  for (let i = 0; i < ax3B.length; i++) {
    const t = axTB[i] || [];
    const j = computeJerkMagnitude(
      t,
      ax3B[i] || [],
      ay3B[i] || [],
      az3B[i] || []
    );
    for (const v of j) jerkValsB.push(v);
    if (jerkValsB.length >= maxPoints) break;
  }

  diag.jerkB = jerkValsB.length;

  const jerkMin = Math.min(
    percentile(jerkValsA, 0.5),
    percentile(jerkValsB, 0.5)
  );
  const jerkMax = Math.max(
    percentile(jerkValsA, 99.5),
    percentile(jerkValsB, 99.5)
  );

  setChart(
    state.charts.jerk,
    histogramDensity(jerkValsA, 80, jerkMin, jerkMax),
    histogramDensity(jerkValsB, 80, jerkMin, jerkMax)
  );

  const yawRateValsA = [];
  for (let i = 0; i < yawTA.length; i++) {
    const rr = computeYawRate(yawTA[i] || [], yawVA[i] || []);
    for (const v of rr) yawRateValsA.push(v);
    if (yawRateValsA.length >= maxPoints) break;
  }

  diag.yawRateA = yawRateValsA.length;

  const yawRateValsB = [];
  for (let i = 0; i < yawTB.length; i++) {
    const rr = computeYawRate(yawTB[i] || [], yawVB[i] || []);
    for (const v of rr) yawRateValsB.push(v);
    if (yawRateValsB.length >= maxPoints) break;
  }

  diag.yawRateB = yawRateValsB.length;

  const yawMin = Math.min(
    percentile(yawRateValsA, 0.5),
    percentile(yawRateValsB, 0.5)
  );
  const yawMax = Math.max(
    percentile(yawRateValsA, 99.5),
    percentile(yawRateValsB, 99.5)
  );

  setChart(
    state.charts.yawRate,
    histogramDensity(yawRateValsA, 80, yawMin, yawMax),
    histogramDensity(yawRateValsB, 80, yawMin, yawMax)
  );

  const msA = meanStd(speedValsA);
  const msB = meanStd(speedValsB);
  const axsA = meanStd(axValsA);
  const axsB = meanStd(axValsB);

  const emptyWarnings = [];
  if (speedValsA.length === 0) emptyWarnings.push("speed(A)=0");
  if (speedValsB.length === 0) emptyWarnings.push("speed(B)=0");
  if (axValsA.length === 0) emptyWarnings.push("accelX(A)=0");
  if (axValsB.length === 0) emptyWarnings.push("accelX(B)=0");
  if (ayValsA.length === 0) emptyWarnings.push("accelY(A)=0");
  if (ayValsB.length === 0) emptyWarnings.push("accelY(B)=0");
  if (jerkValsA.length === 0) emptyWarnings.push("jerk(A)=0");
  if (jerkValsB.length === 0) emptyWarnings.push("jerk(B)=0");
  if (yawRateValsA.length === 0) emptyWarnings.push("yawRate(A)=0");
  if (yawRateValsB.length === 0) emptyWarnings.push("yawRate(B)=0");

  setSummary(
    `<div class="metaPanel"><div class="metaTitle">Summary</div><div class="metaGrid">` +
      `<div class="metaRow"><div class="metaLabel">Speed mean ± std (A)</div><div class="metaValue"><code>${msA.mean.toFixed(
        2
      )} ± ${msA.std.toFixed(2)}</code></div></div>` +
      `<div class="metaRow"><div class="metaLabel">Speed mean ± std (B)</div><div class="metaValue"><code>${msB.mean.toFixed(
        2
      )} ± ${msB.std.toFixed(2)}</code></div></div>` +
      `<div class="metaRow"><div class="metaLabel">Accel X mean ± std (A)</div><div class="metaValue"><code>${axsA.mean.toFixed(
        3
      )} ± ${axsA.std.toFixed(3)}</code></div></div>` +
      `<div class="metaRow"><div class="metaLabel">Accel X mean ± std (B)</div><div class="metaValue"><code>${axsB.mean.toFixed(
        3
      )} ± ${axsB.std.toFixed(3)}</code></div></div>` +
      `<div class="metaRow"><div class="metaLabel">Samples loaded</div><div class="metaValue"><code>speed A=${diag.speedA}, B=${diag.speedB} · ax A=${diag.axA}, B=${diag.axB} · ay A=${diag.ayA}, B=${diag.ayB} · jerk A=${diag.jerkA}, B=${diag.jerkB} · yawRate A=${diag.yawRateA}, B=${diag.yawRateB}</code></div></div>` +
      `</div></div>`
  );

  if (emptyWarnings.length > 0) {
    setError(
      `Some series are empty: ${emptyWarnings.join(
        ", "
      )}\n\nOpen DevTools Console and reload Compare if needed.`
    );
  } else {
    setError("");
  }
}

async function main() {
  setError("");
  await loadTrips();
  syncPickers();
  attachEvents();
  ensureCharts();
}

main().catch((err) => {
  setError(String(err?.message || err));
});
