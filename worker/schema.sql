-- Gougueule – base de données D1
-- À exécuter : wrangler d1 execute gougueule-db --file=schema.sql

CREATE TABLE IF NOT EXISTS accounts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT    NOT NULL UNIQUE,
  salt         TEXT    NOT NULL,
  password_h   TEXT    NOT NULL,   -- PBKDF2‑SHA256, base64
  created_at   INTEGER NOT NULL    -- UNIX timestamp
);

CREATE TABLE IF NOT EXISTS admin_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash     TEXT    NOT NULL UNIQUE,  -- SHA‑256 hex de la clé en clair
  used         INTEGER NOT NULL DEFAULT 0,
  account_id   INTEGER REFERENCES accounts(id)
);
