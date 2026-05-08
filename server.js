const express = require('express');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Get all trips
app.get('/api/trips', (req, res) => {
  const trips = db.prepare('SELECT * FROM trips ORDER BY created_at DESC').all();
  res.json(trips);
});

// Get summary stats
app.get('/api/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as count, COALESCE(SUM(distance), 0) as miles FROM trips WHERE status = ?').get('completed');
  const active = db.prepare('SELECT COUNT(*) as count FROM trips WHERE status = ?').get('active');
  res.json({
    totalTrips: total.count,
    totalMiles: total.miles,
    activeTrips: active.count,
  });
});

// Create a new trip
app.post('/api/trips', (req, res) => {
  const { name, description, start_mileage } = req.body;
  if (!name || start_mileage === undefined || start_mileage === null || isNaN(start_mileage)) {
    return res.status(400).json({ error: 'Name and start mileage are required' });
  }
  const stmt = db.prepare('INSERT INTO trips (name, description, start_mileage, status) VALUES (?, ?, ?, ?)');
  const result = stmt.run(name.trim(), description ? description.trim() : null, parseFloat(start_mileage), 'active');
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(trip);
});

// End a trip (add end mileage)
app.put('/api/trips/:id/end', (req, res) => {
  const { end_mileage } = req.body;
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (trip.status === 'completed') return res.status(400).json({ error: 'Trip already completed' });
  if (end_mileage === undefined || isNaN(end_mileage)) return res.status(400).json({ error: 'End mileage is required' });

  const endMi = parseFloat(end_mileage);
  if (endMi < trip.start_mileage) {
    return res.status(400).json({ error: 'End mileage must be greater than or equal to start mileage' });
  }

  const distance = endMi - trip.start_mileage;
  db.prepare('UPDATE trips SET end_mileage = ?, distance = ?, status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(endMi, distance, 'completed', req.params.id);

  const updated = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Delete a trip
app.delete('/api/trips/:id', (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  db.prepare('DELETE FROM trips WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Mileage Tracker running on port ${PORT}`);
});
