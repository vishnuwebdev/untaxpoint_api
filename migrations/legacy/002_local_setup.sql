-- Run AFTER 001_initial.sql (in MySQL Workbench: File > Open SQL Script, then the lightning-bolt "Execute" button).
-- Adds what the API needs on top of the starter schema, creates a local app user, and seeds demo data.
USE untaxpoint;

-- Single-row platform wallet (replaces "platformCents" from store.json).
CREATE TABLE IF NOT EXISTS platform_account (
  id TINYINT PRIMARY KEY,
  balance_cents BIGINT NOT NULL DEFAULT 0
);
INSERT IGNORE INTO platform_account (id, balance_cents) VALUES (1, 250000);

-- Admin funding notes.
ALTER TABLE ledger_entries ADD COLUMN note VARCHAR(500) NULL AFTER status;
CREATE INDEX idx_ledger_created ON ledger_entries (created_at);

-- Demo seed data (same as the JSON demo).
INSERT IGNORE INTO users (id, name, email, wallet_cents, status)
VALUES ('user_demo', 'Demo Member', 'member@example.com', 0, 'active');
INSERT IGNORE INTO events (id, title, description, address, latitude, longitude, radius_meters,
  pool_cents, remaining_cents, max_winners, starts_at, ends_at, status)
VALUES ('evt_demo', 'City Center Challenge',
  'Visit the event area and submit a participation request while it is active.',
  'City Center', 40.7128000, -74.0060000, 500, 50000, 50000, 10,
  UTC_TIMESTAMP(3) - INTERVAL 1 HOUR, UTC_TIMESTAMP(3) + INTERVAL 1 DAY, 'active');

-- Dedicated local login for the API (local development only; change the password if you like,
-- and put the same value in api/.env as DB_PASSWORD).
CREATE USER IF NOT EXISTS 'untaxpoint_app'@'localhost' IDENTIFIED BY 'untaxpoint_local_dev';
CREATE USER IF NOT EXISTS 'untaxpoint_app'@'127.0.0.1' IDENTIFIED BY 'untaxpoint_local_dev';
GRANT SELECT, INSERT, UPDATE, DELETE ON untaxpoint.* TO 'untaxpoint_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON untaxpoint.* TO 'untaxpoint_app'@'127.0.0.1';
FLUSH PRIVILEGES;
