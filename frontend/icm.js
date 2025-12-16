const els = {
  reload: document.getElementById("icmReload"),
  search: document.getElementById("icmSearch"),
  sort: document.getElementById("icmSort"),
  meta: document.getElementById("icmMeta"),
  wrap: document.getElementById("icmWrap"),
  driverList: document.getElementById("icmDriverList"),
  detailHeader: document.getElementById("icmDetailHeader"),
  evidence: document.getElementById("icmEvidence"),
  evidenceHeader: document.getElementById("icmEvidenceHeader"),
  evidenceWrap: document.getElementById("icmEvidenceWrap"),
  hSplitter: document.getElementById("icmHSplitter"),
  detail: document.getElementById("icmDetail"),
  main: document.getElementById("icmMain"),
  splitter: document.getElementById("icmSplitter"),
};

let state = {
  drivers: [],
  selectedDriverId: "",
  selectedEvidence: null,
  evidenceData: null,
  evidenceStats: null,
  evidenceOnlyEvents: false,
};

const ICM_SIDEBAR_WIDTH_KEY = "uah_icm_sidebar_width_px_v1";
const ICM_EVIDENCE_HEIGHT_KEY = "uah_icm_evidence_height_px_v1";

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function applyEvidenceHeightPx(px) {
  const detail = els.detail;
  if (!detail) return;
  // evidence block height
  const h = clamp(Math.floor(safeNumber(px, 240)), 140, 700);
  // header + trips + splitter + evidence
  detail.style.gridTemplateRows = `auto 1fr auto ${h}px`;
  try {
    window.localStorage.setItem(ICM_EVIDENCE_HEIGHT_KEY, String(h));
  } catch {
    // ignore
  }
}

function restoreEvidenceHeight() {
  try {
    const raw = window.localStorage.getItem(ICM_EVIDENCE_HEIGHT_KEY);
    if (!raw) return;
    const h = safeNumber(raw, null);
    if (h == null) return;
    applyEvidenceHeightPx(h);
  } catch {
    // ignore
  }
}

function showEvidenceUi() {
  if (els.hSplitter) els.hSplitter.hidden = false;
  if (els.evidence) els.evidence.hidden = false;
  // Only apply a fixed height if the user previously resized the splitter.
  restoreEvidenceHeight();
}

function hideEvidenceUi() {
  if (els.hSplitter) els.hSplitter.hidden = true;
  if (els.evidence) els.evidence.hidden = true;
}

function applySidebarWidthPx(px) {
  const main = els.main;
  if (!main) return;
  const w = clamp(Math.floor(safeNumber(px, 320)), 220, 700);
  main.style.gridTemplateColumns = `${w}px 8px 1fr`;
  try {
    window.localStorage.setItem(ICM_SIDEBAR_WIDTH_KEY, String(w));
  } catch {
    // ignore
  }
}

function restoreSidebarWidth() {
  try {
    const raw = window.localStorage.getItem(ICM_SIDEBAR_WIDTH_KEY);
    if (!raw) return;
    const w = safeNumber(raw, null);
    if (w == null) return;
    applySidebarWidthPx(w);
  } catch {
    // ignore
  }
}

function attachSplitter() {
  const main = els.main;
  const splitter = els.splitter;
  if (!main || !splitter) return;

  let dragging = false;

  const onMove = (clientX) => {
    const rect = main.getBoundingClientRect();
    // width from left edge of grid to cursor
    const w = clientX - rect.left;
    applySidebarWidthPx(w);
  };

  const onPointerMove = (e) => {
    if (!dragging) return;
    onMove(e.clientX);
  };

  const stop = () => {
    if (!dragging) return;
    dragging = false;
    try {
      splitter.releasePointerCapture?.(activePointerId);
    } catch {
      // ignore
    }
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stop);
  };

  let activePointerId = null;
  splitter.addEventListener("pointerdown", (e) => {
    dragging = true;
    activePointerId = e.pointerId;
    try {
      splitter.setPointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }
    onMove(e.clientX);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stop);
  });

  splitter.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 30 : 10;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const computed = window.getComputedStyle(main);
    const cols = (computed.gridTemplateColumns || "").split(" ");
    const current = safeNumber(cols[0]?.replace("px", ""), 320);
    const next = e.key === "ArrowLeft" ? current - step : current + step;
    applySidebarWidthPx(next);
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function fmt(n, digits = 2) {
  const x = safeNumber(n, null);
  if (x == null) return "";
  return x.toFixed(digits);
}

function renderError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (els.meta) els.meta.textContent = "";
  if (els.wrap)
    els.wrap.innerHTML = `<div style="padding:10px"><code>${escapeHtml(
      msg
    )}</code></div>`;
  if (els.driverList) els.driverList.innerHTML = "";
  if (els.detailHeader) els.detailHeader.innerHTML = "";
  if (els.evidence) els.evidence.hidden = true;
}

function hideEvidence() {
  state.selectedEvidence = null;
  state.evidenceData = null;
  state.evidenceStats = null;
  state.evidenceOnlyEvents = false;
  hideEvidenceUi();
  if (els.evidenceHeader) els.evidenceHeader.innerHTML = "";
  if (els.evidenceWrap) els.evidenceWrap.innerHTML = "";
}

function attachHorizontalSplitter() {
  const detail = els.detail;
  const splitter = els.hSplitter;
  if (!detail || !splitter) return;

  let dragging = false;
  let activePointerId = null;

  const onMove = (clientY) => {
    const rect = detail.getBoundingClientRect();
    // compute evidence height based on cursor position from bottom
    const h = rect.bottom - clientY;
    applyEvidenceHeightPx(h);
  };

  const onPointerMove = (e) => {
    if (!dragging) return;
    onMove(e.clientY);
  };

  const stop = () => {
    if (!dragging) return;
    dragging = false;
    try {
      splitter.releasePointerCapture?.(activePointerId);
    } catch {
      // ignore
    }
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stop);
  };

  splitter.addEventListener("pointerdown", (e) => {
    dragging = true;
    activePointerId = e.pointerId;
    try {
      splitter.setPointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }
    onMove(e.clientY);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stop);
  });

  splitter.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 30 : 10;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const computed = window.getComputedStyle(detail);
    const rows = (computed.gridTemplateRows || "").split(" ");
    const current = safeNumber(rows[3]?.replace("px", ""), 280);
    const next = e.key === "ArrowUp" ? current + step : current - step;
    applyEvidenceHeightPx(next);
  });
}

function evidenceKindFromColumnIndex(colIndex) {
  // Trip table columns indexes:
  // 0 Trip
  // 1 Trip ICM
  // 2 Trip km
  // 3 Duration (min)
  // 4 Speeding (min)
  // 5 Harsh accel
  // 6 Harsh brake
  // 7 Harsh turns
  if (colIndex === 4) return "speeding";
  if (colIndex === 5) return "harsh_accel";
  if (colIndex === 6) return "harsh_brake";
  if (colIndex === 7) return "harsh_turns";
  return null;
}

function evidenceTitle(kind) {
  if (kind === "speeding") return "Speeding evidence";
  if (kind === "harsh_accel") return "Harsh accel evidence";
  if (kind === "harsh_brake") return "Harsh brake evidence";
  if (kind === "harsh_turns") return "Harsh turns evidence";
  return "Evidence";
}

async function loadEvidence(tripId, kind, onlyEvents) {
  const url = `/api/trips/${encodeURIComponent(
    tripId
  )}/evidence?kind=${encodeURIComponent(kind)}&only_events=${encodeURIComponent(
    onlyEvents ? "true" : "false"
  )}&max_rows=0`;
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(txt || "Failed to load evidence");
  }
  return await res.json();
}

function renderEvidenceTable(columns, rows) {
  const cols = Array.isArray(columns) ? columns : [];
  const rws = Array.isArray(rows) ? rows : [];

  const thead = `<thead><tr>${cols
    .map((c) => `<th><code>${escapeHtml(c)}</code></th>`)
    .join("")}</tr></thead>`;

  const tbody = `<tbody>${rws
    .map((row) => {
      const cells = Array.isArray(row) ? row : [];
      const isEvent = Boolean(cells[cells.length - 1]);
      return `<tr class="${
        isEvent ? "icmEvidenceEvent" : "icmEvidenceNonEvent"
      }">${cols
        .map((_, i) => {
          const v = cells[i];
          const n = Number(v);
          const s = Number.isFinite(n) ? n.toFixed(6) : String(v ?? "");
          return `<td><code>${escapeHtml(s)}</code></td>`;
        })
        .join("")}</tr>`;
    })
    .join("")}</tbody>`;

  return `<table class="dataTable">${thead}${tbody}</table>`;
}

function renderEvidenceFromState() {
  if (!els.evidenceWrap) return;
  const data = state.evidenceData;
  if (!data) {
    els.evidenceWrap.innerHTML = "";
    return;
  }

  const columns = Array.isArray(data.columns) ? data.columns : [];
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const filtered = state.evidenceOnlyEvents
    ? rows.filter((r) => Array.isArray(r) && Boolean(r[r.length - 1]))
    : rows;

  els.evidenceWrap.innerHTML = renderEvidenceTable(columns, filtered);
}

function renderEvidenceHeader(kind, tripId) {
  if (!els.evidenceHeader) return;

  const checked = state.evidenceOnlyEvents ? "checked" : "";
  const st = state.evidenceStats;
  const statsText = st
    ? `samples=${escapeHtml(
        String(st.totalSamples ?? "")
      )} · eventEdges=${escapeHtml(
        String(st.eventEdges ?? "")
      )} · exceedSamples=${escapeHtml(
        String(st.exceedSamples ?? "")
      )} · all rows loaded`
    : "";
  els.evidenceHeader.innerHTML = `
    <div class="icmEvidenceHeaderLeft">
      <div class="icmEvidenceTitle"><code>${escapeHtml(
        evidenceTitle(kind)
      )}</code></div>
      <div class="icmEvidenceMeta"><code>${escapeHtml(
        tripLabelFromTripId(tripId)
      )}</code>${
    statsText ? ` <code style="opacity:0.8">${statsText}</code>` : ""
  }</div>
    </div>
    <div class="icmEvidenceHeaderRight">
      <label class="icmEvidenceToggle">
        <input id="icmEvidenceOnlyEvents" type="checkbox" ${checked} />
        Only events
      </label>
    </div>
  `;

  const cb = document.getElementById("icmEvidenceOnlyEvents");
  if (cb) {
    cb.addEventListener("change", async () => {
      state.evidenceOnlyEvents = Boolean(cb.checked);

      // If user requests only events, re-fetch from backend with server-side filtering
      // so we don't lose events due to max_rows clipping.
      if (state.evidenceOnlyEvents && state.selectedEvidence) {
        const { tripId: tid, kind: k } = state.selectedEvidence;
        if (els.evidenceWrap)
          els.evidenceWrap.innerHTML = `<div style="padding:10px"><code>Loading...</code></div>`;
        try {
          const json = await loadEvidence(tid, k, true);
          state.evidenceData = {
            columns: json.columns || [],
            rows: json.rows || [],
          };
          state.evidenceStats = json.stats || null;
          renderEvidenceHeader(k, tid);
          renderEvidenceFromState();
          return;
        } catch (e) {
          // fall back to client-side filtering
          state.evidenceStats = null;
        }
      }

      renderEvidenceFromState();
    });
  }
}

function tripLabelFromTripId(tripId) {
  if (!tripId || typeof tripId !== "string") return tripId;
  const parts = tripId.split("|");
  return parts[1] || tripId;
}

function parseQuery() {
  const sp = new URLSearchParams(window.location.search);
  return {
    driverId: sp.get("driverId") || "",
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

function normalizedIncludes(hay, needle) {
  return String(hay).toLowerCase().includes(String(needle).toLowerCase());
}

function sortedDrivers(drivers, sortKey) {
  const list = Array.isArray(drivers) ? Array.from(drivers) : [];
  if (sortKey === "km_desc") {
    list.sort(
      (a, b) => safeNumber(b.distanceKm, 0) - safeNumber(a.distanceKm, 0)
    );
  } else if (sortKey === "driver_asc") {
    list.sort((a, b) =>
      String(a.driverId ?? "").localeCompare(String(b.driverId ?? ""))
    );
  } else {
    // default: icm_desc
    list.sort((a, b) => safeNumber(b.icm, 0) - safeNumber(a.icm, 0));
  }
  return list;
}

function renderMeta(drivers) {
  const count = Array.isArray(drivers) ? drivers.length : 0;
  if (els.meta) els.meta.textContent = `drivers=${count}`;
}

function renderDriversList(drivers) {
  if (!els.driverList) return;
  const q = els.search?.value || "";
  const sortKey = els.sort?.value || "icm_desc";

  const filtered = sortedDrivers(
    (Array.isArray(drivers) ? drivers : []).filter((d) => {
      if (!q) return true;
      return normalizedIncludes(d.driverId ?? "", q);
    }),
    sortKey
  );

  if (filtered.length === 0) {
    els.driverList.innerHTML = `<div style="padding:10px"><code>No drivers</code></div>`;
    return;
  }

  const items = filtered
    .map((d) => {
      const id = String(d.driverId ?? "");
      const active = id === state.selectedDriverId;
      const icm = fmt(d.icm, 2);
      const km = fmt(d.distanceKm, 2);
      return `
        <button
          type="button"
          class="icmDriverItem ${active ? "active" : ""}"
          data-driver-id="${escapeHtml(id)}"
          title="${escapeHtml(id)}"
        >
          <div class="icmDriverTop">
            <div class="icmDriverName"><code>${escapeHtml(id)}</code></div>
            <div class="icmDriverScore"><code>${escapeHtml(icm)}</code></div>
          </div>
          <div class="icmDriverBottom">
            <code>${escapeHtml(km)} km</code>
          </div>
        </button>
      `;
    })
    .join("");

  els.driverList.innerHTML = items;

  els.driverList.querySelectorAll(".icmDriverItem").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.driverId || "";
      if (!id) return;
      state.selectedDriverId = id;
      setQuery({ driverId: id });
      renderDriversList(state.drivers);
      renderDriverDetail(state.drivers, id);
    });
  });
}

function renderDriverDetail(drivers, driverId) {
  const driver = (Array.isArray(drivers) ? drivers : []).find(
    (d) => String(d.driverId ?? "") === String(driverId)
  );

  if (els.detailHeader) {
    if (!driver) {
      els.detailHeader.innerHTML = `<div class="icmDetailTitle"><code>Select a driver</code></div>`;
    } else {
      const tripsCount = Array.isArray(driver.trips) ? driver.trips.length : 0;
      els.detailHeader.innerHTML = `
        <div class="icmDetailTitle"><code>${escapeHtml(
          driver.driverId
        )}</code></div>
        <div class="icmDetailStats">
          <code>ICM ${escapeHtml(fmt(driver.icm, 2))}</code>
          <code>${escapeHtml(fmt(driver.distanceKm, 2))} km</code>
          <code>${escapeHtml(String(tripsCount))} trips</code>
        </div>
      `;
    }
  }

  if (!els.wrap) return;
  if (!driver) {
    els.wrap.innerHTML = "";
    hideEvidence();
    return;
  }

  const trips = Array.isArray(driver.trips) ? Array.from(driver.trips) : [];
  trips.sort((a, b) => safeNumber(b.icm, 0) - safeNumber(a.icm, 0));

  const columns = [
    "Trip",
    "Trip ICM",
    "Trip km",
    "Duration (min)",
    "Speeding (min)",
    "Harsh accel",
    "Harsh brake",
    "Harsh turns",
  ];

  const thead = `<thead><tr>${columns
    .map((c) => `<th><code>${escapeHtml(c)}</code></th>`)
    .join("")}</tr></thead>`;

  const tbody = `<tbody>${trips
    .map((t) => {
      const tripId = String(t.tripId ?? "");
      const cells = [
        tripLabelFromTripId(t.tripId),
        fmt(t.icm, 2),
        fmt(t.distanceKm, 2),
        fmt(safeNumber(t.durationSeconds, 0) / 60.0, 1),
        fmt(safeNumber(t.speedingSeconds, 0) / 60.0, 1),
        String(t.harshAccelEvents ?? ""),
        String(t.harshBrakeEvents ?? ""),
        String(t.harshTurnEvents ?? ""),
      ];
      return `<tr data-trip-id="${escapeHtml(tripId)}">${cells
        .map((v, i) => {
          const kind = evidenceKindFromColumnIndex(i);
          const cls = kind ? "icmDrillCell" : "";
          const title = kind ? "Click to view evidence" : "";
          return `<td class="${cls}" data-ev-kind="${escapeHtml(
            kind || ""
          )}" title="${escapeHtml(title)}"><code>${escapeHtml(
            v ?? ""
          )}</code></td>`;
        })
        .join("")}</tr>`;
    })
    .join("")}</tbody>`;

  els.wrap.innerHTML = `<table class="dataTable">${thead}${tbody}</table>`;

  // Wire up drilldown clicks
  els.wrap.querySelectorAll("td.icmDrillCell").forEach((cell) => {
    cell.addEventListener("click", async () => {
      const tr = cell.closest("tr");
      const tripId = tr?.dataset?.tripId || "";
      const kind = cell.dataset.evKind || "";
      if (!tripId || !kind) return;

      state.selectedEvidence = { tripId, kind };

      showEvidenceUi();
      renderEvidenceHeader(kind, tripId);
      if (els.evidenceWrap)
        els.evidenceWrap.innerHTML = `<div style="padding:10px"><code>Loading...</code></div>`;

      try {
        const json = await loadEvidence(tripId, kind, false);
        state.evidenceData = {
          columns: json.columns || [],
          rows: json.rows || [],
        };
        state.evidenceStats = json.stats || null;
        renderEvidenceHeader(kind, tripId);
        renderEvidenceFromState();
      } catch (e) {
        state.evidenceData = null;
        state.evidenceStats = null;
        if (els.evidenceWrap)
          els.evidenceWrap.innerHTML = `<div style="padding:10px"><code>${escapeHtml(
            e instanceof Error ? e.message : String(e)
          )}</code></div>`;
      }
    });
  });
}

async function loadIcm() {
  const res = await fetch("/api/icm");
  if (!res.ok) throw new Error("Failed to load ICM");
  const json = await res.json();

  state.drivers = Array.isArray(json.drivers) ? json.drivers : [];
  renderMeta(state.drivers);

  const q = parseQuery();
  const preferred =
    q.driverId &&
    state.drivers.some((d) => String(d.driverId) === String(q.driverId))
      ? q.driverId
      : state.drivers[0]?.driverId || "";

  state.selectedDriverId = String(preferred || "");
  renderDriversList(state.drivers);
  renderDriverDetail(state.drivers, state.selectedDriverId);
  hideEvidence();
}

async function main() {
  restoreSidebarWidth();
  attachSplitter();
  attachHorizontalSplitter();
  try {
    await loadIcm();
  } catch (e) {
    renderError(e);
  }

  if (els.reload) {
    els.reload.addEventListener("click", async () => {
      try {
        await loadIcm();
      } catch (e) {
        renderError(e);
      }
    });
  }

  if (els.search) {
    els.search.addEventListener("input", () => {
      renderDriversList(state.drivers);
    });
  }

  if (els.sort) {
    els.sort.addEventListener("change", () => {
      renderDriversList(state.drivers);
    });
  }
}

main();
