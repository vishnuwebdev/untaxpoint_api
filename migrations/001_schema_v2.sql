-- UNTAXPOINT schema v2 (MySQL 8). Applied by `npm run migrate`.
-- Money is always integer cents (BIGINT). All DATETIME values are UTC.
-- Replaces the demo tables from migrations/legacy (they only ever held demo data).

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS participations, ledger_entries, audit_events, events, users, platform_account;
SET FOREIGN_KEY_CHECKS = 1;

-- ---------------------------------------------------------------- administrators
CREATE TABLE admins (
  id            VARCHAR(40)  PRIMARY KEY,
  name          VARCHAR(120) NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('super_admin','finance_admin','event_admin','support') NOT NULL,
  status        ENUM('active','disabled') NOT NULL DEFAULT 'active',
  last_login_at DATETIME(3) NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);

-- ---------------------------------------------------------------- members
CREATE TABLE users (
  id                VARCHAR(40)  PRIMARY KEY,
  full_name         VARCHAR(160) NOT NULL,
  email             VARCHAR(255) NOT NULL UNIQUE,
  password_hash     VARCHAR(255) NULL,
  phone             VARCHAR(32)  NULL,
  avatar_url        VARCHAR(500) NULL,
  status            ENUM('active','suspended','deleted') NOT NULL DEFAULT 'active',
  status_reason     VARCHAR(255) NULL,
  is_flagged        BOOLEAN NOT NULL DEFAULT FALSE,
  flag_reason       VARCHAR(255) NULL,
  email_verified_at DATETIME(3) NULL,
  referral_code     VARCHAR(16)  NOT NULL UNIQUE,
  referred_by       VARCHAR(40)  NULL,
  wallet_cents      BIGINT NOT NULL DEFAULT 0,
  last_latitude     DECIMAL(10,7) NULL,
  last_longitude    DECIMAL(10,7) NULL,
  last_location_at  DATETIME(3) NULL,
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_wallet_non_negative CHECK (wallet_cents >= 0),
  CONSTRAINT fk_users_referred_by FOREIGN KEY (referred_by) REFERENCES users(id),
  INDEX idx_users_status (status, created_at)
);

-- Where a member's withdrawals are paid. Full bank numbers are never stored here;
-- a real payment provider will tokenize them.
CREATE TABLE user_payout_accounts (
  user_id             VARCHAR(40) PRIMARY KEY,
  method              ENUM('paypal','bank') NOT NULL,
  paypal_email        VARCHAR(255) NULL,
  account_holder_name VARCHAR(160) NULL,
  bank_name           VARCHAR(160) NULL,
  bank_account_last4  CHAR(4) NULL,
  updated_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_payout_user FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Refresh tokens for admins and members (only a SHA-256 hash is stored).
CREATE TABLE refresh_tokens (
  id           VARCHAR(40) PRIMARY KEY,
  subject_type ENUM('admin','user') NOT NULL,
  subject_id   VARCHAR(40) NOT NULL,
  token_hash   CHAR(64) NOT NULL UNIQUE,
  expires_at   DATETIME(3) NOT NULL,
  revoked_at   DATETIME(3) NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_refresh_subject (subject_type, subject_id)
);

-- ---------------------------------------------------------------- configuration
CREATE TABLE settings (
  setting_key   VARCHAR(64) PRIMARY KEY,
  setting_value JSON NOT NULL,
  updated_by    VARCHAR(40) NULL,
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);
INSERT INTO settings (setting_key, setting_value) VALUES
  ('default_radius_meters',            '100'),
  ('max_location_accuracy_meters',     '100'),
  ('nearby_notification_radius_meters','5000'),
  ('min_withdrawal_cents',             '1000'),
  ('max_withdrawal_cents',             '500000'),
  ('withdrawal_hold_threshold_cents',  '50000'),
  ('min_donation_cents',               '100'),
  ('currency',                         '"USD"');

-- ---------------------------------------------------------------- events
CREATE TABLE events (
  id                 VARCHAR(40)  PRIMARY KEY,
  title              VARCHAR(200) NOT NULL,
  description        TEXT NOT NULL,
  address            VARCHAR(400) NULL,
  latitude           DECIMAL(10,7) NOT NULL,
  longitude          DECIMAL(10,7) NOT NULL,
  radius_meters      INT NOT NULL,
  pool_cents         BIGINT NOT NULL,
  max_winners        INT NOT NULL,
  starts_at          DATETIME(3) NOT NULL,
  ends_at            DATETIME(3) NOT NULL,
  timezone           VARCHAR(64) NOT NULL DEFAULT 'America/New_York',
  status             ENUM('draft','scheduled','active','capacity_reached','paused','completed','expired','cancelled') NOT NULL DEFAULT 'draft',
  participants_count INT NOT NULL DEFAULT 0,
  winners_count      INT NOT NULL DEFAULT 0,
  created_by         VARCHAR(40) NULL,
  published_at       DATETIME(3) NULL,
  paused_at          DATETIME(3) NULL,
  cancelled_at       DATETIME(3) NULL,
  cancel_reason      VARCHAR(500) NULL,
  settled_at         DATETIME(3) NULL,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_event_pool    CHECK (pool_cents > 0),
  CONSTRAINT chk_event_winners CHECK (max_winners >= 1),
  CONSTRAINT chk_event_radius  CHECK (radius_meters >= 1),
  CONSTRAINT chk_event_window  CHECK (ends_at > starts_at),
  INDEX idx_events_status_window (status, starts_at, ends_at),
  INDEX idx_events_location (latitude, longitude)
);

CREATE TABLE event_images (
  id         VARCHAR(40) PRIMARY KEY,
  event_id   VARCHAR(40) NOT NULL,
  file_name  VARCHAR(255) NOT NULL,
  url        VARCHAR(500) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_image_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  INDEX idx_images_event (event_id, sort_order)
);

-- Every participation attempt, accepted or rejected (for reporting and fraud review).
CREATE TABLE participation_requests (
  id                VARCHAR(40) PRIMARY KEY,
  event_id          VARCHAR(40) NOT NULL,
  user_id           VARCHAR(40) NOT NULL,
  latitude          DECIMAL(10,7) NULL,
  longitude         DECIMAL(10,7) NULL,
  accuracy_meters   DECIMAL(8,2) NULL,
  distance_meters   DECIMAL(12,2) NULL,
  is_mock_location  BOOLEAN NOT NULL DEFAULT FALSE,
  outcome           ENUM('accepted','rejected') NOT NULL,
  reject_reason     VARCHAR(48) NULL,
  ip_address        VARCHAR(64) NULL,
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_req_event FOREIGN KEY (event_id) REFERENCES events(id),
  CONSTRAINT fk_req_user  FOREIGN KEY (user_id)  REFERENCES users(id),
  INDEX idx_req_event (event_id, outcome),
  INDEX idx_req_user (user_id, created_at)
);

-- Accepted participants. sequence_no is assigned by the server under a row lock on the event.
CREATE TABLE participations (
  id           VARCHAR(40) PRIMARY KEY,
  event_id     VARCHAR(40) NOT NULL,
  user_id      VARCHAR(40) NOT NULL,
  request_id   VARCHAR(40) NOT NULL,
  sequence_no  INT NOT NULL,
  is_winner    BOOLEAN NOT NULL DEFAULT FALSE,
  payout_cents BIGINT NULL,
  accepted_at  DATETIME(3) NOT NULL,
  CONSTRAINT fk_part_event   FOREIGN KEY (event_id)   REFERENCES events(id),
  CONSTRAINT fk_part_user    FOREIGN KEY (user_id)    REFERENCES users(id),
  CONSTRAINT fk_part_request FOREIGN KEY (request_id) REFERENCES participation_requests(id),
  UNIQUE KEY uq_part_event_user (event_id, user_id),
  UNIQUE KEY uq_part_event_seq (event_id, sequence_no),
  INDEX idx_part_user (user_id, accepted_at)
);

CREATE TABLE event_settlements (
  event_id              VARCHAR(40) PRIMARY KEY,
  pool_cents            BIGINT NOT NULL,
  max_winners           INT NOT NULL,
  total_requests        INT NOT NULL,
  unique_users          INT NOT NULL,
  accepted_participants INT NOT NULL,
  rejected_requests     INT NOT NULL,
  duplicate_requests    INT NOT NULL,
  out_of_radius         INT NOT NULL,
  outside_window        INT NOT NULL,
  winner_count          INT NOT NULL,
  payout_base_cents     BIGINT NOT NULL,
  remainder_cents       BIGINT NOT NULL,
  distributed_cents     BIGINT NOT NULL,
  released_cents        BIGINT NOT NULL,
  report                JSON NOT NULL,
  settled_at            DATETIME(3) NOT NULL,
  CONSTRAINT fk_settle_event FOREIGN KEY (event_id) REFERENCES events(id),
  CONSTRAINT chk_settle_balance CHECK (pool_cents = distributed_cents + released_cents)
);

-- ---------------------------------------------------------------- money
-- Cached balances for platform accounts. The ledger is the source of truth;
-- GET /admin/finance/reconciliation compares the two.
CREATE TABLE platform_accounts (
  code          VARCHAR(32) PRIMARY KEY,
  name          VARCHAR(80) NOT NULL,
  balance_cents BIGINT NOT NULL DEFAULT 0,
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);
INSERT INTO platform_accounts (code, name) VALUES
  ('main',            'Main fund (available)'),
  ('reserved',        'Reserved for events'),
  ('donations',       'Donated fund'),
  ('payouts_pending', 'Withdrawals in progress'),
  ('external',        'External money (in/out of the platform)');

CREATE TABLE withdrawals (
  id                 VARCHAR(40) PRIMARY KEY,
  user_id            VARCHAR(40) NOT NULL,
  amount_cents       BIGINT NOT NULL,
  currency           CHAR(3) NOT NULL DEFAULT 'USD',
  status             ENUM('requested','processing','pending','completed','failed','rejected','reversed','on_hold') NOT NULL,
  method             ENUM('paypal','bank') NOT NULL,
  destination        VARCHAR(255) NOT NULL,
  provider           VARCHAR(32) NOT NULL,
  provider_ref       VARCHAR(128) NULL,
  hold_reason        VARCHAR(255) NULL,
  failure_reason     VARCHAR(255) NULL,
  reviewed_by        VARCHAR(40) NULL,
  reviewed_at        DATETIME(3) NULL,
  review_note        VARCHAR(500) NULL,
  completed_at       DATETIME(3) NULL,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_wd_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT chk_wd_amount CHECK (amount_cents > 0),
  INDEX idx_wd_status (status, created_at),
  INDEX idx_wd_user (user_id, created_at)
);

-- One row per business transaction (funding, reservation, reward, withdrawal, donation...).
CREATE TABLE transactions (
  id              VARCHAR(40) PRIMARY KEY,
  kind            ENUM('platform_funding','event_reservation','event_reservation_adjustment','event_release',
                       'reward_credit','withdrawal','withdrawal_reversal','donation','admin_adjustment') NOT NULL,
  status          ENUM('pending','completed','failed','reversed') NOT NULL,
  amount_cents    BIGINT NOT NULL,
  currency        CHAR(3) NOT NULL DEFAULT 'USD',
  user_id         VARCHAR(40) NULL,
  event_id        VARCHAR(40) NULL,
  withdrawal_id   VARCHAR(40) NULL,
  actor_type      ENUM('admin','user','system') NOT NULL,
  actor_id        VARCHAR(40) NULL,
  description     VARCHAR(500) NULL,
  provider        VARCHAR(32) NULL,
  provider_ref    VARCHAR(128) NULL,
  idempotency_key VARCHAR(160) NOT NULL UNIQUE,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_txn_user  FOREIGN KEY (user_id)  REFERENCES users(id),
  CONSTRAINT fk_txn_event FOREIGN KEY (event_id) REFERENCES events(id),
  CONSTRAINT fk_txn_wd    FOREIGN KEY (withdrawal_id) REFERENCES withdrawals(id),
  CONSTRAINT chk_txn_amount CHECK (amount_cents > 0),
  INDEX idx_txn_kind (kind, created_at),
  INDEX idx_txn_user (user_id, created_at),
  INDEX idx_txn_event (event_id),
  INDEX idx_txn_created (created_at)
);

-- Double-entry ledger: the entries of every posting sum to zero.
-- account is 'main' | 'reserved' | 'donations' | 'payouts_pending' | 'external' | 'user'
CREATE TABLE ledger_entries (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  transaction_id      VARCHAR(40) NOT NULL,
  account             VARCHAR(32) NOT NULL,
  user_id             VARCHAR(40) NULL,
  amount_cents        BIGINT NOT NULL,
  balance_after_cents BIGINT NOT NULL,
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_ledger_txn  FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  CONSTRAINT fk_ledger_user FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_ledger_account (account, id),
  INDEX idx_ledger_user (user_id, id)
);

-- ---------------------------------------------------------------- audit
CREATE TABLE audit_logs (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  actor_type  ENUM('admin','user','system') NOT NULL,
  actor_id    VARCHAR(40) NULL,
  action      VARCHAR(80) NOT NULL,
  target_type VARCHAR(40) NULL,
  target_id   VARCHAR(40) NULL,
  details     JSON NULL,
  ip_address  VARCHAR(64) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_audit_created (created_at),
  INDEX idx_audit_target (target_type, target_id),
  INDEX idx_audit_actor (actor_type, actor_id)
);
