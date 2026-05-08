const express = require('express');
const path = require('path');
const { pool, init } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  const { name, description, start_mileage } = req.body;
  if (!name || start_mileage === undefined || start_mileage === null || isNaN(start_mileage)) {
    return res.status(400).json({ error: 'Name and start mileage are required' });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO trips (name, description, start_mileage, status) VALUES ($1, $2, $3, $4) RETURNING *',
      [name.trim(), description ? description.trim() : null, parseFloat(start_mileage), 'active']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// End a trip (add end mileage)
app.put('/api/trips/:id/end', async (req, res) => {
  const { end_mileage } = req.body;
  if (end_mileage === undefined || isNaN(end_mileage)) {
    return res.status(400).json({ error: 'End mileage is required' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM trips WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Trip not found' });
    const trip = rows[0];
    if (trip.status === 'completed') return res.status(400).json({ error: 'Trip already completed' });

    const endMi = parseFloat(end_mileage);
    if (endMi < trip.start_mileage) {
      return res.status(400).json({ error: 'End mileage must be greater than or equal to start mileage' });
    }

    const distance = endMi - trip.start_mileage;
    const updated = await pool.query(
      'UPDATE trips SET end_mileage = $1, distance = $2, status = $3, completed_at = NOW() WHERE id = $4 RETURNING *',
      [endMi, distance, 'completed', req.params.id]
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
    if (rowCount === 0) return res.status(404).json({ error: 'Trip not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

init().then(() => {
  app.listen(PORT, () => {
    console.log(`Mileage Tracker running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
