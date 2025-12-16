const els = {
  driver: document.getElementById("tblDriver"),
  trip: document.getElementById("tblTrip"),
  file: document.getElementById("tblFile"),
  downsample: document.getElementById("tblDownsample"),
  offset: document.getElementById("tblOffset"),
  limit: document.getElementById("tblLimit"),
  prev: document.getElementById("tblPrev"),
  next: document.getElementById("tblNext"),
  load: document.getElementById("tblLoad"),
  meta: document.getElementById("tblMeta"),
  wrap: document.getElementById("tblWrap"),
};

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function uniqueSorted(arr) {
  return Array.from(new Set(arr)).sort();
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

function parseQuery() {
  const sp = new URLSearchParams(window.location.search);
  const tripId = sp.get("tripId") || "";
  const file = sp.get("file") || "";
  const downsample = sp.get("downsample");
  const offset = sp.get("offset");
  const limit = sp.get("limit");
  return {
    tripId,
    file,
    downsample: downsample != null ? safeNumber(downsample, null) : null,
    offset: offset != null ? safeNumber(offset, null) : null,
    limit: limit != null ? safeNumber(limit, null) : null,
  };
}

function setQuery(patch) {
  const sp = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === "") sp.delete(k);
    else sp.set(k, String(v));
  }
  const next = `${window.location.pathname}?${sp.toString()}`;
  window.history.replaceState(null, "", next);
}

function renderTableError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (els.meta) els.meta.textContent = "";
  if (els.wrap)
    els.wrap.innerHTML = `<div style="padding:10px"><code>${escapeHtml(
      msg
    )}</code></div>`;
}

function renderTable(columns, rows, meta) {
  const cols = Array.isArray(columns) ? columns : [];
  const rws = Array.isArray(rows) ? rows : [];
  const timeShiftSeconds = Number(meta?.offsetSeconds) || 0;
  const hasTimeCol = cols.length > 0 && String(cols[0]) === "t";
  const addVideoTimeCol =
    hasTimeCol && Number.isFinite(timeShiftSeconds) && timeShiftSeconds !== 0;

  if (els.meta) {
    const parts = [];
    if (meta?.file) parts.push(`file=${meta.file}`);
    if (typeof meta?.downsample === "number")
      parts.push(`downsample=${meta.downsample}`);
    if (typeof meta?.offset === "number") parts.push(`offset=${meta.offset}`);
    if (typeof meta?.limit === "number") parts.push(`limit=${meta.limit}`);
    if (typeof meta?.total === "number") parts.push(`total=${meta.total}`);
    els.meta.textContent = parts.join(" · ");
  }

  const displayCols = addVideoTimeCol
    ? [cols[0], "t_data", ...cols.slice(1)]
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
          if (j === 0) v = tVideo;
          else if (j === 1) v = cells[0];
          else v = cells[j - 1];
          const s = Number.isFinite(v) ? Number(v).toFixed(6) : String(v ?? "");
          return `<td><code>${escapeHtml(s)}</code></td>`;
        })
        .join("")}</tr>`;
    })
    .join("")}</tbody>`;

  if (els.wrap)
    els.wrap.innerHTML = `<table class="dataTable">${thead}${tbody}</table>`;
}

async function loadTrips() {
  const res = await fetch("/api/trips");
  if (!res.ok) throw new Error("Failed to load trips");
  const json = await res.json();
  const trips = Array.isArray(json.trips) ? json.trips : [];

  const drivers = uniqueSorted(
    trips.map((t) => driverFromTripId(t.id)).filter(Boolean)
  );

  const q = parseQuery();
  const preferredTripId =
    q.tripId && trips.some((t) => t.id === q.tripId) ? q.tripId : "";
  const preferredDriver = preferredTripId
    ? driverFromTripId(preferredTripId)
    : drivers[0] || "";

  if (els.driver) {
    els.driver.innerHTML = "";
    for (const d of drivers) {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d;
      els.driver.appendChild(opt);
    }
    els.driver.value = preferredDriver;
  }

  const renderTripsForDriver = (driver, preferred) => {
    if (!els.trip) return;
    const list = trips.filter((t) => driverFromTripId(t.id) === driver);
    els.trip.innerHTML = "";
    for (const t of list) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = tripLabelFromTripId(t.id);
      els.trip.appendChild(opt);
    }
    if (preferred && list.some((t) => t.id === preferred))
      els.trip.value = preferred;
    else if (list.length) els.trip.value = list[0].id;
  };

  renderTripsForDriver(preferredDriver, preferredTripId);

  if (els.driver) {
    els.driver.addEventListener("change", () => {
      renderTripsForDriver(els.driver.value, "");
      setQuery({ tripId: els.trip?.value || "" });
    });
  }

  if (els.trip) {
    els.trip.addEventListener("change", () => {
      setQuery({ tripId: els.trip.value });
    });
  }

  // Apply query params to controls
  if (q.file && els.file) els.file.value = q.file;
  if (q.downsample != null && els.downsample)
    els.downsample.value = String(q.downsample);
  if (q.offset != null && els.offset) els.offset.value = String(q.offset);
  if (q.limit != null && els.limit) els.limit.value = String(q.limit);

  // Keep query in sync
  const syncQueryFromControls = () => {
    setQuery({
      tripId: els.trip?.value || "",
      file: els.file?.value || "",
      downsample: safeNumber(els.downsample?.value, 10),
      offset: Math.max(0, Math.floor(safeNumber(els.offset?.value, 0))),
      limit: Math.max(1, Math.floor(safeNumber(els.limit?.value, 200))),
    });
  };

  if (els.file) els.file.addEventListener("change", syncQueryFromControls);
  if (els.downsample)
    els.downsample.addEventListener("change", syncQueryFromControls);
  if (els.offset) els.offset.addEventListener("change", syncQueryFromControls);
  if (els.limit) els.limit.addEventListener("change", syncQueryFromControls);
}

async function loadTable() {
  const tripId = els.trip?.value;
  if (!tripId) throw new Error("No trip selected");
  const file = String(els.file?.value || "RAW_GPS");
  const downsample = clamp(safeNumber(els.downsample?.value, 10), 1, 1000);
  const offset = Math.max(0, Math.floor(safeNumber(els.offset?.value, 0)));
  const limit = clamp(Math.floor(safeNumber(els.limit?.value, 200)), 1, 2000);

  setQuery({ tripId, file, downsample, offset, limit });

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

function attachEvents() {
  if (els.load) {
    els.load.addEventListener("click", () => {
      loadTable().catch((e) => renderTableError(e));
    });
  }
  if (els.prev) {
    els.prev.addEventListener("click", () => {
      const cur = Math.max(0, Math.floor(safeNumber(els.offset?.value, 0)));
      const step = Math.max(1, Math.floor(safeNumber(els.limit?.value, 200)));
      const next = Math.max(0, cur - step);
      if (els.offset) els.offset.value = String(next);
      loadTable().catch((e) => renderTableError(e));
    });
  }
  if (els.next) {
    els.next.addEventListener("click", () => {
      const cur = Math.max(0, Math.floor(safeNumber(els.offset?.value, 0)));
      const step = Math.max(1, Math.floor(safeNumber(els.limit?.value, 200)));
      const next = cur + step;
      if (els.offset) els.offset.value = String(next);
      loadTable().catch((e) => renderTableError(e));
    });
  }
}

async function main() {
  attachEvents();
  await loadTrips();
  const q = parseQuery();
  // Auto-load if tripId is provided (e.g. opened from main app)
  if (q.tripId) {
    loadTable().catch((e) => renderTableError(e));
  }
}

main().catch((e) => renderTableError(e));
