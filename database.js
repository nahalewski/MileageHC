const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trips (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      from_address TEXT,
      to_address TEXT,
      start_mileage REAL,
      end_mileage REAL,
      distance REAL,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `);
  // Migrations for existing tables
  await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS from_address TEXT`);
  await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS to_address TEXT`);
  await pool.query(`ALTER TABLE trips ALTER COLUMN start_mileage DROP NOT NULL`);
}

module.exports = { pool, init };
