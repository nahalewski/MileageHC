const express = require('express');
const path = require('path');
const { pool, init } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Front-end config (safe to expose)
app.get('/api/config', (req, res) => {
  res.json({ mapsApiKey: process.env.GOOGLE_MAPS_API_KEY || null });
});

// Distance via Google Maps Distance Matrix API
app.get('/api/distance', async (req, res) => {
  const { origin, destination } = req.query;
  if (!origin || !destination) {
    return res.status(400).json({ error: 'origin and destination are required' });
  }
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    return res.status(503).json({ error: 'Google Maps API key not configured on server' });
  }
  try {
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&units=imperial&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status !== 'OK') {
      return res.status(400).json({ error: `Maps API: ${data.status} — ${data.error_message || ''}` });
    }
    const el = data.rows[0]?.elements[0];
    if (!el || el.status !== 'OK') {
      return res.status(400).json({ error: 'Could not calculate distance for those addresses' });
    }
    res.json({
      miles: parseFloat((el.distance.value / 1609.344).toFixed(2)),
      text: el.distance.text,
      duration: el.duration.text,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all trips
app.get('/api/trips', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM trips ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get summary stats
app.get('/api/stats', async (req, res) => {
  try {
    const completed = await pool.query(
      "SELECT COUNT(*) as count, COALESCE(SUM(distance), 0) as miles FROM trips WHERE status = 'completed'"
    );
    const active = await pool.query(
      "SELECT COUNT(*) as count FROM trips WHERE status = 'active'"
    );
    res.json({
      totalTrips: parseInt(completed.rows[0].count),
      totalMiles: parseFloat(completed.rows[0].miles),
      activeTrips: parseInt(active.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new trip
app.post('/api/trips', async (req, res) => {
  const { name, description, from_address, to_address, start_mileage, distance } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const hasAddresses = from_address && to_address && distance != null;
  const hasOdometer = start_mileage != null && !isNaN(start_mileage);

  if (!hasAddresses && !hasOdometer) {
    return res.status(400).json({ error: 'Provide either start mileage or from/to addresses with distance' });
  }

  try {
    if (hasAddresses && !hasOdometer) {
      // Address-based trip — completed immediately
      const { rows } = await pool.query(
        `INSERT INTO trips (name, description, from_address, to_address, distance, status, completed_at)
         VALUES ($1,$2,$3,$4,$5,'completed',NOW()) RETURNING *`,
        [name.trim(), description?.trim() || null, from_address.trim(), to_address.trim(), parseFloat(distance)]
      );
      return res.status(201).json(rows[0]);
    }
    // Odometer-based trip — active until ended
    const { rows } = await pool.query(
      `INSERT INTO trips (name, description, from_address, to_address, start_mileage, status)
       VALUES ($1,$2,$3,$4,$5,'active') RETURNING *`,
      [name.trim(), description?.trim() || null, from_address?.trim() || null, to_address?.trim() || null, parseFloat(start_mileage)]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// End a trip
app.put('/api/trips/:id/end', async (req, res) => {
  const { end_mileage } = req.body;
  if (end_mileage == null || isNaN(end_mileage)) {
    return res.status(400).json({ error: 'End mileage is required' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM trips WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Trip not found' });
    const trip = rows[0];
    if (trip.status === 'completed') return res.status(400).json({ error: 'Trip already completed' });
    const endMi = parseFloat(end_mileage);
    if (endMi < trip.start_mileage) {
      return res.status(400).json({ error: 'End mileage must be ≥ start mileage' });
    }
    const updated = await pool.query(
      `UPDATE trips SET end_mileage=$1, distance=$2, status='completed', completed_at=NOW()
       WHERE id=$3 RETURNING *`,
      [endMi, endMi - trip.start_mileage, req.params.id]
    );
    res.json(updated.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a trip
app.delete('/api/trips/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM trips WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Trip not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

init().then(() => {
  app.listen(PORT, () => console.log(`Mileage Tracker running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
