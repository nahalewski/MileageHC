const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const SEED_USERS = [
  { username: 'David',  password: 'David2024!'  },
  { username: 'Andrew', password: 'Andrew2024!' },
  { username: 'Ann',    password: 'Ann2024!'    },
  { username: 'Matt',   password: 'Matt2024!'   },
  { username: 'Jared',  password: 'Jared2024!'  },
  { username: 'Ben',    password: 'Ben2024!'    },
  { username: 'Bryan',  password: 'Bryan2024!'  },
];

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      must_change_password BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trips (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
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

  // Migrations for existing installs
  await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS from_address TEXT`);
  await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS to_address TEXT`);
  await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
  await pool.query(`ALTER TABLE trips ALTER COLUMN start_mileage DROP NOT NULL`);

  // Seed users (idempotent)
  for (const u of SEED_USERS) {
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [u.username]);
    if (!rows.length) {
      const hash = await bcrypt.hash(u.password, 10);
      await pool.query(
        'INSERT INTO users (username, password_hash, must_change_password) VALUES ($1, $2, TRUE)',
        [u.username, hash]
      );
      console.log(`Created user: ${u.username}`);
    }
  }
}

module.exports = { pool, init };
