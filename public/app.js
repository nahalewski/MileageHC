/* global state */
let endingTripId = null;
let endingStartMi = null;

/* ── DOM refs ── */
const newTripForm = document.getElementById('new-trip-form');
const formError = document.getElementById('form-error');
const activeTripsEl = document.getElementById('active-trips');
const completedTripsEl = document.getElementById('completed-trips');
const activeCountEl = document.getElementById('active-count');
const historyCountEl = document.getElementById('history-count');
const statTotalMiles = document.getElementById('stat-total-miles');
const statTotalTrips = document.getElementById('stat-total-trips');
const statActiveTrips = document.getElementById('stat-active-trips');
const endModal = document.getElementById('end-modal');
const endMileageInput = document.getElementById('end-mileage-input');
const modalTripName = document.getElementById('modal-trip-name');
const modalStartMi = document.getElementById('modal-start-mi');
const modalPreview = document.getElementById('modal-preview');
const modalDistance = document.getElementById('modal-distance');
const modalError = document.getElementById('modal-error');

/* ── Utilities ── */
function fmt(n) {
  return parseFloat(n).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError(el) {
  el.classList.add('hidden');
}

/* ── API helpers ── */
async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* ── Render functions ── */
function renderActiveTrips(trips) {
  activeCountEl.textContent = trips.length;
  if (trips.length === 0) {
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
      <div class="trip-card__mileage">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        Start: <strong>${fmt(t.start_mileage)} mi</strong>
      </div>
      <div class="trip-card__started">${fmtDate(t.created_at)}</div>
      <div class="trip-card__actions">
        <button class="btn btn--end" onclick="openEndModal(${t.id}, '${escHtml(t.name).replace(/'/g, "\\'")}', ${t.start_mileage})">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          End Trip
        </button>
      </div>
    </div>
  `).join('');
}

function renderCompletedTrips(trips) {
  historyCountEl.textContent = trips.length;
  if (trips.length === 0) {
    completedTripsEl.innerHTML = '<div class="empty-state">No completed trips yet.</div>';
    return;
  }
  completedTripsEl.innerHTML = trips.map(t => `
    <div class="trip-row" data-id="${t.id}">
      <div class="trip-row__info">
        <div class="trip-row__name">${escHtml(t.name)}</div>
        <div class="trip-row__meta">
          ${t.description ? `<span>${escHtml(t.description)}</span>` : ''}
          <span>${fmt(t.start_mileage)} → ${fmt(t.end_mileage)} mi</span>
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
    </div>
  `).join('');
}

function renderStats(stats) {
  statTotalMiles.textContent = fmt(stats.totalMiles);
  statTotalTrips.textContent = stats.totalTrips;
  statActiveTrips.textContent = stats.activeTrips;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Load data ── */
async function loadAll() {
  const [trips, stats] = await Promise.all([
    apiFetch('/api/trips'),
    apiFetch('/api/stats'),
  ]);
  const active = trips.filter(t => t.status === 'active');
  const completed = trips.filter(t => t.status === 'completed');
  renderActiveTrips(active);
  renderCompletedTrips(completed);
  renderStats(stats);
}

/* ── New trip form ── */
newTripForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError(formError);
  const name = document.getElementById('trip-name').value.trim();
  const description = document.getElementById('trip-description').value.trim();
  const start_mileage = document.getElementById('start-mileage').value;

  try {
    await apiFetch('/api/trips', {
      method: 'POST',
      body: JSON.stringify({ name, description, start_mileage: parseFloat(start_mileage) }),
    });
    newTripForm.reset();
    await loadAll();
  } catch (err) {
    showError(formError, err.message);
  }
});

/* ── End trip modal ── */
function openEndModal(id, name, startMi) {
  endingTripId = id;
  endingStartMi = startMi;
  modalTripName.textContent = name;
  modalStartMi.textContent = fmt(startMi);
  endMileageInput.value = '';
  hideError(modalError);
  modalPreview.classList.add('hidden');
  endModal.classList.remove('hidden');
  endMileageInput.focus();
}

endMileageInput.addEventListener('input', () => {
  const val = parseFloat(endMileageInput.value);
  if (!isNaN(val) && endingStartMi !== null && val >= endingStartMi) {
    modalDistance.textContent = fmt(val - endingStartMi);
    modalPreview.classList.remove('hidden');
  } else {
    modalPreview.classList.add('hidden');
  }
});

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-cancel').addEventListener('click', closeModal);
endModal.addEventListener('click', (e) => { if (e.target === endModal) closeModal(); });

function closeModal() {
  endModal.classList.add('hidden');
  endingTripId = null;
  endingStartMi = null;
}

document.getElementById('modal-confirm').addEventListener('click', async () => {
  hideError(modalError);
  const end_mileage = parseFloat(endMileageInput.value);
  if (isNaN(end_mileage)) {
    showError(modalError, 'Please enter a valid end mileage.');
    return;
  }
  try {
    await apiFetch(`/api/trips/${endingTripId}/end`, {
      method: 'PUT',
      body: JSON.stringify({ end_mileage }),
    });
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

/* ── Keyboard: close modal on Escape ── */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !endModal.classList.contains('hidden')) closeModal();
});

/* ── Init ── */
loadAll();
