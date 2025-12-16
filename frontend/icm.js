const els = {
  reload: document.getElementById("icmReload"),
  search: document.getElementById("icmSearch"),
  sort: document.getElementById("icmSort"),
  meta: document.getElementById("icmMeta"),
  wrap: document.getElementById("icmWrap"),
  driverList: document.getElementById("icmDriverList"),
  detailHeader: document.getElementById("icmDetailHeader"),
};

let state = {
  drivers: [],
  selectedDriverId: "",
};

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
      return `<tr>${cells
        .map((v) => `<td><code>${escapeHtml(v ?? "")}</code></td>`)
        .join("")}</tr>`;
    })
    .join("")}</tbody>`;

  els.wrap.innerHTML = `<table class="dataTable">${thead}${tbody}</table>`;
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
}

async function main() {
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
