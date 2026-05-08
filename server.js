const express = require('express');
const path = require('path');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { pool, init } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new pgSession({ pool, tableName: 'sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'mhc-dev-fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
  },
}));

/* ── Auth middleware ── */
function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

/* ── Auth routes ── */
app.get('/api/auth/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ id: req.session.userId, username: req.session.username, mustChangePassword: req.session.mustChangePassword });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username.trim()]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid username or password' });
    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid username or password' });
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.mustChangePassword = user.must_change_password;
    res.json({ id: user.id, username: user.username, mustChangePassword: user.must_change_password });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  try {
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash=$1, must_change_password=FALSE WHERE id=$2', [hash, req.session.userId]);
    req.session.mustChangePassword = false;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Config (public) ── */
app.get('/api/config', (req, res) => {
  res.json({ mapsApiKey: process.env.GOOGLE_MAPS_API_KEY || null });
});

/* ── Distance via Google Maps ── */
app.get('/api/distance', requireAuth, async (req, res) => {
  const { origin, destination } = req.query;
  if (!origin || !destination) return res.status(400).json({ error: 'origin and destination required' });
  if (!process.env.GOOGLE_MAPS_API_KEY) return res.status(503).json({ error: 'Google Maps API key not configured' });
  try {
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&units=imperial&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status !== 'OK') return res.status(400).json({ error: `Maps API: ${data.status}` });
    const el = data.rows[0]?.elements[0];
    if (!el || el.status !== 'OK') return res.status(400).json({ error: 'Could not calculate distance for those addresses' });
    res.json({
      miles: parseFloat((el.distance.value / 1609.344).toFixed(2)),
      text: el.distance.text,
      duration: el.duration.text,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Trips (all scoped to current user) ── */
app.get('/api/trips', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM trips WHERE user_id=$1 ORDER BY created_at DESC',
      [req.session.userId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const completed = await pool.query(
      "SELECT COUNT(*) as count, COALESCE(SUM(distance),0) as miles FROM trips WHERE user_id=$1 AND status='completed'",
      [req.session.userId]
    );
    const active = await pool.query(
      "SELECT COUNT(*) as count FROM trips WHERE user_id=$1 AND status='active'",
      [req.session.userId]
    );
    res.json({
      totalTrips: parseInt(completed.rows[0].count),
      totalMiles: parseFloat(completed.rows[0].miles),
      activeTrips: parseInt(active.rows[0].count),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/trips', requireAuth, async (req, res) => {
  const { name, description, from_address, to_address, start_mileage, distance } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const hasAddresses = from_address && to_address && distance != null;
  const hasOdometer  = start_mileage != null && !isNaN(start_mileage);
  if (!hasAddresses && !hasOdometer) {
    return res.status(400).json({ error: 'Provide start mileage or from/to addresses with distance' });
  }
  try {
    if (hasAddresses && !hasOdometer) {
      const { rows } = await pool.query(
        `INSERT INTO trips (user_id,name,description,from_address,to_address,distance,status,completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,'completed',NOW()) RETURNING *`,
        [req.session.userId, name.trim(), description?.trim()||null, from_address.trim(), to_address.trim(), parseFloat(distance)]
      );
      return res.status(201).json(rows[0]);
    }
    const { rows } = await pool.query(
      `INSERT INTO trips (user_id,name,description,from_address,to_address,start_mileage,status)
       VALUES ($1,$2,$3,$4,$5,$6,'active') RETURNING *`,
      [req.session.userId, name.trim(), description?.trim()||null, from_address?.trim()||null, to_address?.trim()||null, parseFloat(start_mileage)]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/trips/:id/end', requireAuth, async (req, res) => {
  const { end_mileage } = req.body;
  if (end_mileage == null || isNaN(end_mileage)) return res.status(400).json({ error: 'End mileage required' });
  try {
    const { rows } = await pool.query('SELECT * FROM trips WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
    if (!rows.length) return res.status(404).json({ error: 'Trip not found' });
    const trip = rows[0];
    if (trip.status === 'completed') return res.status(400).json({ error: 'Trip already completed' });
    const endMi = parseFloat(end_mileage);
    if (endMi < trip.start_mileage) return res.status(400).json({ error: 'End mileage must be ≥ start mileage' });
    const updated = await pool.query(
      `UPDATE trips SET end_mileage=$1,distance=$2,status='completed',completed_at=NOW() WHERE id=$3 RETURNING *`,
      [endMi, endMi - trip.start_mileage, req.params.id]
    );
    res.json(updated.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/trips/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM trips WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
    if (!rowCount) return res.status(404).json({ error: 'Trip not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

init().then(() => {
  app.listen(PORT, () => console.log(`Mileage Tracker running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
