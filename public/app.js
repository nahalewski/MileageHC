/* ── State ── */
let currentMode = 'odometer';
let calculatedMiles = null;
let mapsEnabled = false;
let endingTripId = null;
let endingStartMi = null;

/* ── DOM refs ── */
const newTripForm    = document.getElementById('new-trip-form');
const formError      = document.getElementById('form-error');
const activeTripsEl  = document.getElementById('active-trips');
const completedEl    = document.getElementById('completed-trips');
const activeCountEl  = document.getElementById('active-count');
const historyCountEl = document.getElementById('history-count');
const submitBtn      = document.getElementById('submit-btn');
const submitLabel    = document.getElementById('submit-label');
const endModal       = document.getElementById('end-modal');
const endMiInput     = document.getElementById('end-mileage-input');
const modalTripName  = document.getElementById('modal-trip-name');
const modalStartMi   = document.getElementById('modal-start-mi');
const modalPreview   = document.getElementById('modal-preview');
const modalDistance  = document.getElementById('modal-distance');
const modalError     = document.getElementById('modal-error');

/* ── Utilities ── */
const fmt = n => parseFloat(n).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const fmtDate = iso => new Date(iso).toLocaleString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
});

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showError(el, msg) { el.textContent = msg; el.classList.remove('hidden'); }
function hideError(el)       { el.classList.add('hidden'); }

/* ── API ── */
async function apiFetch(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* ── Google Maps init ── */
async function initMaps() {
  try {
    const cfg = await apiFetch('/api/config');
    if (!cfg.mapsApiKey) {
      document.getElementById('maps-unavailable').classList.remove('hidden');
      document.getElementById('address-inputs').classList.add('hidden');
      return;
    }
    mapsEnabled = true;
    await loadMapsScript(cfg.mapsApiKey);
    setupAutocomplete();
  } catch (e) {
    console.warn('Maps init failed:', e.message);
  }
}

function loadMapsScript(key) {
  return new Promise((resolve, reject) => {
    window.__onMapsReady = resolve;
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places&callback=__onMapsReady&loading=async`;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function setupAutocomplete() {
  const opts = { fields: ['formatted_address', 'geometry'] };
  new google.maps.places.Autocomplete(document.getElementById('from-address'), opts);
  new google.maps.places.Autocomplete(document.getElementById('to-address'), opts);
}

/* ── Mode toggle ── */
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});

function setMode(mode) {
  currentMode = mode;
  calculatedMiles = null;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  document.getElementById('panel-odometer').classList.toggle('hidden', mode !== 'odometer');
  document.getElementById('panel-address').classList.toggle('hidden',  mode !== 'address');
  document.getElementById('distance-result').classList.add('hidden');
  hideError(formError);

  if (mode === 'odometer') {
    submitLabel.textContent = 'Start Trip';
    submitBtn.disabled = false;
  } else {
    submitLabel.textContent = 'Add Trip';
    submitBtn.disabled = true;
  }
}

/* ── Get distance from Maps ── */
document.getElementById('get-distance-btn').addEventListener('click', async () => {
  const origin      = document.getElementById('from-address').value.trim();
  const destination = document.getElementById('to-address').value.trim();
  hideError(formError);

  if (!origin || !destination) {
    showError(formError, 'Enter both a from and to address first.');
    return;
  }

  const btn = document.getElementById('get-distance-btn');
  btn.disabled = true;
  btn.querySelector('span') ? null : null;
  const origText = btn.innerHTML;
  btn.innerHTML = '&nbsp;Calculating…';

  try {
    const result = await apiFetch(
      `/api/distance?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`
    );
    calculatedMiles = result.miles;
    document.getElementById('dist-miles').textContent = fmt(result.miles);
    document.getElementById('dist-duration').textContent = result.duration;
    document.getElementById('distance-result').classList.remove('hidden');
    submitBtn.disabled = false;
  } catch (err) {
    showError(formError, err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = origText;
  }
});

/* ── New trip form submit ── */
newTripForm.addEventListener('submit', async e => {
  e.preventDefault();
  hideError(formError);

  const name        = document.getElementById('trip-name').value.trim();
  const description = document.getElementById('trip-description').value.trim();

  try {
    if (currentMode === 'odometer') {
      const start_mileage = parseFloat(document.getElementById('start-mileage').value);
      if (!name || isNaN(start_mileage)) {
        showError(formError, 'Trip name and start mileage are required.');
        return;
      }
      await apiFetch('/api/trips', {
        method: 'POST',
        body: JSON.stringify({ name, description, start_mileage }),
      });
    } else {
      if (!calculatedMiles) {
        showError(formError, 'Click "Get Distance from Google Maps" before adding the trip.');
        return;
      }
      const from_address = document.getElementById('from-address').value.trim();
      const to_address   = document.getElementById('to-address').value.trim();
      if (!name || !from_address || !to_address) {
        showError(formError, 'Name, from address, and to address are required.');
        return;
      }
      await apiFetch('/api/trips', {
        method: 'POST',
        body: JSON.stringify({ name, description, from_address, to_address, distance: calculatedMiles }),
      });
    }

    newTripForm.reset();
    calculatedMiles = null;
    document.getElementById('distance-result').classList.add('hidden');
    if (currentMode === 'address') submitBtn.disabled = true;
    await loadAll();
  } catch (err) {
    showError(formError, err.message);
  }
});

/* ── Render: active trips ── */
function renderActiveTrips(trips) {
  activeCountEl.textContent = trips.length;
  if (!trips.length) {
    activeTripsEl.innerHTML = '<div class="empty-state">No active trips. Start one above!</div>';
    return;
  }
  activeTripsEl.innerHTML = trips.map(t => `
    <div class="trip-card" data-id="${t.id}">
      <button class="trip-delete" onclick="deleteTrip(${t.id})" title="Delete trip">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <div class="trip-card__name">${escHtml(t.name)}</div>
      ${t.description ? `<div class="trip-card__desc">${escHtml(t.description)}</div>` : ''}
      ${t.from_address && t.to_address ? `
        <div class="trip-card__addr">
          <span><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>${escHtml(t.from_address)}</span>
          <span><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>${escHtml(t.to_address)}</span>
        </div>` : ''}
      <div class="trip-card__mileage">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        Start: <strong>${fmt(t.start_mileage)} mi</strong>
      </div>
      <div class="trip-card__started">${fmtDate(t.created_at)}</div>
      <div class="trip-card__actions">
        <button class="btn btn--end" onclick="openEndModal(${t.id},'${escHtml(t.name).replace(/'/g,"\\'")}',${t.start_mileage})">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          End Trip
        </button>
      </div>
    </div>
  `).join('');
}

/* ── Render: completed trips ── */
function renderCompletedTrips(trips) {
  historyCountEl.textContent = trips.length;
  if (!trips.length) {
    completedEl.innerHTML = '<div class="empty-state">No completed trips yet.</div>';
    return;
  }
  completedEl.innerHTML = trips.map(t => {
    const mapsUrl = t.from_address && t.to_address
      ? `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(t.from_address)}&destination=${encodeURIComponent(t.to_address)}`
      : null;

    const metaAddr = mapsUrl
      ? `<span class="trip-row__addr">
           <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
           ${escHtml(t.from_address)} → ${escHtml(t.to_address)}
           <a href="${mapsUrl}" target="_blank" rel="noopener" title="Open in Google Maps">
             <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
             Maps
           </a>
         </span>`
      : `<span>${fmt(t.start_mileage)} → ${fmt(t.end_mileage)} mi</span>`;

    return `
    <div class="trip-row" data-id="${t.id}">
      <div class="trip-row__info">
        <div class="trip-row__name">${escHtml(t.name)}</div>
        <div class="trip-row__meta">
          ${t.description ? `<span>${escHtml(t.description)}</span>` : ''}
          ${metaAddr}
          <span>${fmtDate(t.completed_at || t.created_at)}</span>
        </div>
      </div>
      <div class="trip-row__right">
        <div class="trip-row__distance">
          ${fmt(t.distance)}
          <span>miles</span>
        </div>
        <button class="btn btn--danger-ghost" onclick="deleteTrip(${t.id})" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');
}

/* ── Render: stats ── */
function renderStats(stats) {
  document.getElementById('stat-total-miles').textContent = fmt(stats.totalMiles);
  document.getElementById('stat-total-trips').textContent = stats.totalTrips;
  document.getElementById('stat-active-trips').textContent = stats.activeTrips;
}

/* ── Load all data ── */
async function loadAll() {
  const [trips, stats] = await Promise.all([apiFetch('/api/trips'), apiFetch('/api/stats')]);
  renderActiveTrips(trips.filter(t => t.status === 'active'));
  renderCompletedTrips(trips.filter(t => t.status === 'completed'));
  renderStats(stats);
}

/* ── End trip modal ── */
function openEndModal(id, name, startMi) {
  endingTripId = id;
  endingStartMi = startMi;
  modalTripName.textContent = name;
  modalStartMi.textContent  = fmt(startMi);
  endMiInput.value = '';
  hideError(modalError);
  modalPreview.classList.add('hidden');
  endModal.classList.remove('hidden');
  endMiInput.focus();
}

endMiInput.addEventListener('input', () => {
  const val = parseFloat(endMiInput.value);
  if (!isNaN(val) && endingStartMi != null && val >= endingStartMi) {
    modalDistance.textContent = fmt(val - endingStartMi);
    modalPreview.classList.remove('hidden');
  } else {
    modalPreview.classList.add('hidden');
  }
});

function closeModal() {
  endModal.classList.add('hidden');
  endingTripId = null;
  endingStartMi = null;
}

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-cancel').addEventListener('click', closeModal);
endModal.addEventListener('click', e => { if (e.target === endModal) closeModal(); });

document.getElementById('modal-confirm').addEventListener('click', async () => {
  hideError(modalError);
  const end_mileage = parseFloat(endMiInput.value);
  if (isNaN(end_mileage)) { showError(modalError, 'Please enter a valid end mileage.'); return; }
  try {
    await apiFetch(`/api/trips/${endingTripId}/end`, { method: 'PUT', body: JSON.stringify({ end_mileage }) });
    closeModal();
    await loadAll();
  } catch (err) {
    showError(modalError, err.message);
  }
});

/* ── Delete trip ── */
async function deleteTrip(id) {
  if (!confirm('Delete this trip? This cannot be undone.')) return;
  try {
    await apiFetch(`/api/trips/${id}`, { method: 'DELETE' });
    await loadAll();
  } catch (err) {
    alert(err.message);
  }
}

/* ── Keyboard ── */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !endModal.classList.contains('hidden')) closeModal();
});

/* ── Boot ── */
initMaps();
loadAll();
