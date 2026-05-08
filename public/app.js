/* ── Auth state ── */
let currentUser = null;

/* ── Trip form state ── */
let currentMode = 'odometer';
let calculatedMiles = null;
let endingTripId = null;
let endingStartMi = null;

/* ── DOM refs ── */
const loginScreen   = document.getElementById('login-screen');
const appContent    = document.getElementById('app-content');
const loginForm     = document.getElementById('login-form');
const loginError    = document.getElementById('login-error');
const newTripForm   = document.getElementById('new-trip-form');
const formError     = document.getElementById('form-error');
const activeTripsEl = document.getElementById('active-trips');
const completedEl   = document.getElementById('completed-trips');
const activeCountEl = document.getElementById('active-count');
const histCountEl   = document.getElementById('history-count');
const submitBtn     = document.getElementById('submit-btn');
const submitLabel   = document.getElementById('submit-label');
const endModal      = document.getElementById('end-modal');
const endMiInput    = document.getElementById('end-mileage-input');
const modalError    = document.getElementById('modal-error');

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

/* ── Auth flow ── */
async function boot() {
  try {
    const user = await apiFetch('/api/auth/me');
    onLogin(user);
  } catch {
    showLoginScreen();
  }
}

function showLoginScreen() {
  loginScreen.classList.remove('hidden');
  appContent.classList.add('hidden');
  document.getElementById('login-username').focus();
}

function onLogin(user) {
  currentUser = user;
  loginScreen.classList.add('hidden');
  appContent.classList.remove('hidden');
  document.getElementById('header-username').textContent = user.username;
  if (user.mustChangePassword) {
    document.getElementById('changepw-modal').classList.remove('hidden');
  } else {
    initMaps();
    loadAll();
  }
}

loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  hideError(loginError);
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  try {
    const user = await apiFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    onLogin(user);
  } catch (err) {
    showError(loginError, err.message);
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  currentUser = null;
  showLoginScreen();
});

/* ── Change password ── */
document.getElementById('changepw-confirm').addEventListener('click', async () => {
  const pw  = document.getElementById('new-password').value;
  const pw2 = document.getElementById('confirm-password').value;
  const err = document.getElementById('changepw-error');
  hideError(err);
  if (pw.length < 6)  { showError(err, 'Password must be at least 6 characters.'); return; }
  if (pw !== pw2)     { showError(err, 'Passwords do not match.'); return; }
  try {
    await apiFetch('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ newPassword: pw }) });
    document.getElementById('changepw-modal').classList.add('hidden');
    currentUser.mustChangePassword = false;
    initMaps();
    loadAll();
  } catch (err2) {
    showError(err, err2.message);
  }
});

document.getElementById('changepw-signout').addEventListener('click', async () => {
  await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  currentUser = null;
  document.getElementById('changepw-modal').classList.add('hidden');
  showLoginScreen();
});

/* ── Google Maps ── */
async function initMaps() {
  try {
    const cfg = await apiFetch('/api/config');
    if (!cfg.mapsApiKey) {
      document.getElementById('maps-unavailable').classList.remove('hidden');
      document.getElementById('address-inputs').classList.add('hidden');
      return;
    }
    await loadMapsScript(cfg.mapsApiKey);
    setupAutocomplete();
  } catch (e) { console.warn('Maps init failed:', e.message); }
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
  const opts = { fields: ['formatted_address'] };
  new google.maps.places.Autocomplete(document.getElementById('from-address'), opts);
  new google.maps.places.Autocomplete(document.getElementById('to-address'), opts);
}

/* ── Mode toggle ── */
document.querySelectorAll('.mode-btn').forEach(btn => btn.addEventListener('click', () => setMode(btn.dataset.mode)));

function setMode(mode) {
  currentMode = mode;
  calculatedMiles = null;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  document.getElementById('panel-odometer').classList.toggle('hidden', mode !== 'odometer');
  document.getElementById('panel-address').classList.toggle('hidden',  mode !== 'address');
  document.getElementById('distance-result').classList.add('hidden');
  hideError(formError);
  submitLabel.textContent = mode === 'odometer' ? 'Start Trip' : 'Add Trip';
  submitBtn.disabled = mode === 'address';
}

/* ── Get distance ── */
document.getElementById('get-distance-btn').addEventListener('click', async () => {
  const origin = document.getElementById('from-address').value.trim();
  const dest   = document.getElementById('to-address').value.trim();
  hideError(formError);
  if (!origin || !dest) { showError(formError, 'Enter both a from and to address first.'); return; }
  const btn = document.getElementById('get-distance-btn');
  const saved = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '&nbsp;Calculating…';
  try {
    const r = await apiFetch(`/api/distance?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}`);
    calculatedMiles = r.miles;
    document.getElementById('dist-miles').textContent = fmt(r.miles);
    document.getElementById('dist-duration').textContent = r.duration;
    document.getElementById('distance-result').classList.remove('hidden');
    submitBtn.disabled = false;
  } catch (err) {
    showError(formError, err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = saved;
  }
});

/* ── New trip form ── */
newTripForm.addEventListener('submit', async e => {
  e.preventDefault();
  hideError(formError);
  const name        = document.getElementById('trip-name').value.trim();
  const description = document.getElementById('trip-description').value.trim();
  try {
    if (currentMode === 'odometer') {
      const start_mileage = parseFloat(document.getElementById('start-mileage').value);
      if (!name || isNaN(start_mileage)) { showError(formError, 'Trip name and start mileage are required.'); return; }
      await apiFetch('/api/trips', { method: 'POST', body: JSON.stringify({ name, description, start_mileage }) });
    } else {
      if (!calculatedMiles) { showError(formError, 'Click "Get Distance from Google Maps" before adding the trip.'); return; }
      const from_address = document.getElementById('from-address').value.trim();
      const to_address   = document.getElementById('to-address').value.trim();
      if (!name || !from_address || !to_address) { showError(formError, 'Name and both addresses are required.'); return; }
      await apiFetch('/api/trips', { method: 'POST', body: JSON.stringify({ name, description, from_address, to_address, distance: calculatedMiles }) });
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
      <button class="trip-delete" onclick="deleteTrip(${t.id})" title="Delete">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <div class="trip-card__name">${escHtml(t.name)}</div>
      ${t.description ? `<div class="trip-card__desc">${escHtml(t.description)}</div>` : ''}
      ${t.from_address && t.to_address ? `
        <div class="trip-card__addr">
          <span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/></svg>&nbsp;${escHtml(t.from_address)}</span>
          <span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>&nbsp;${escHtml(t.to_address)}</span>
        </div>` : ''}
      <div class="trip-card__mileage">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        Start: <strong>${fmt(t.start_mileage)} mi</strong>
      </div>
      <div class="trip-card__started">${fmtDate(t.created_at)}</div>
      <div class="trip-card__actions">
        <button class="btn btn--end" onclick="openEndModal(${t.id},'${escHtml(t.name).replace(/'/g,"\\'")}',${t.start_mileage})">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          End Trip
        </button>
      </div>
    </div>`).join('');
}

/* ── Render: completed trips ── */
function renderCompletedTrips(trips) {
  histCountEl.textContent = trips.length;
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
           ${escHtml(t.from_address)} → ${escHtml(t.to_address)}
           <a href="${mapsUrl}" target="_blank" rel="noopener">
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
        <div class="trip-row__distance">${fmt(t.distance)}<span>miles</span></div>
        <button class="btn btn--danger-ghost" onclick="deleteTrip(${t.id})">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');
}

function renderStats(stats) {
  document.getElementById('stat-total-miles').textContent = fmt(stats.totalMiles);
  document.getElementById('stat-total-trips').textContent = stats.totalTrips;
  document.getElementById('stat-active-trips').textContent = stats.activeTrips;
}

async function loadAll() {
  const [trips, stats] = await Promise.all([apiFetch('/api/trips'), apiFetch('/api/stats')]);
  renderActiveTrips(trips.filter(t => t.status === 'active'));
  renderCompletedTrips(trips.filter(t => t.status === 'completed'));
  renderStats(stats);
}

/* ── End trip modal ── */
function openEndModal(id, name, startMi) {
  endingTripId = id; endingStartMi = startMi;
  document.getElementById('modal-trip-name').textContent = name;
  document.getElementById('modal-start-mi').textContent  = fmt(startMi);
  endMiInput.value = '';
  hideError(modalError);
  document.getElementById('modal-preview').classList.add('hidden');
  endModal.classList.remove('hidden');
  endMiInput.focus();
}

endMiInput.addEventListener('input', () => {
  const val = parseFloat(endMiInput.value);
  if (!isNaN(val) && endingStartMi != null && val >= endingStartMi) {
    document.getElementById('modal-distance').textContent = fmt(val - endingStartMi);
    document.getElementById('modal-preview').classList.remove('hidden');
  } else {
    document.getElementById('modal-preview').classList.add('hidden');
  }
});

function closeModal() { endModal.classList.add('hidden'); endingTripId = null; endingStartMi = null; }
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-cancel').addEventListener('click', closeModal);
endModal.addEventListener('click', e => { if (e.target === endModal) closeModal(); });

document.getElementById('modal-confirm').addEventListener('click', async () => {
  hideError(modalError);
  const end_mileage = parseFloat(endMiInput.value);
  if (isNaN(end_mileage)) { showError(modalError, 'Please enter a valid end mileage.'); return; }
  try {
    await apiFetch(`/api/trips/${endingTripId}/end`, { method: 'PUT', body: JSON.stringify({ end_mileage }) });
    closeModal(); await loadAll();
  } catch (err) { showError(modalError, err.message); }
});

/* ── Delete ── */
async function deleteTrip(id) {
  if (!confirm('Delete this trip? This cannot be undone.')) return;
  try { await apiFetch(`/api/trips/${id}`, { method: 'DELETE' }); await loadAll(); }
  catch (err) { alert(err.message); }
}

/* ── Keyboard ── */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !endModal.classList.contains('hidden')) closeModal();
});

/* ── Boot ── */
boot();
