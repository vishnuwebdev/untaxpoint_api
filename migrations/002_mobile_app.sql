-- Mobile app support: social sign-in, verification/reset codes, in-app notifications.

ALTER TABLE users
  ADD COLUMN auth_provider ENUM('password','google','apple') NOT NULL DEFAULT 'password' AFTER password_hash,
  ADD COLUMN provider_subject VARCHAR(255) NULL AFTER auth_provider,
  ADD UNIQUE KEY uq_users_provider_subject (auth_provider, provider_subject);

-- One-time codes for email verification and password reset (only a hash is stored).
CREATE TABLE verification_codes (
  id          VARCHAR(40) PRIMARY KEY,
  user_id     VARCHAR(40) NOT NULL,
  purpose     ENUM('verify_email','reset_password') NOT NULL,
  code_hash   CHAR(64) NOT NULL,
  attempts    INT NOT NULL DEFAULT 0,
  expires_at  DATETIME(3) NOT NULL,
  used_at     DATETIME(3) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_vc_user FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_vc_user (user_id, purpose, created_at)
);

-- In-app notifications (push delivery will use the same rows later).
CREATE TABLE notifications (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     VARCHAR(40) NOT NULL,
  type        VARCHAR(40) NOT NULL,
  title       VARCHAR(160) NOT NULL,
  body        VARCHAR(500) NOT NULL,
  event_id    VARCHAR(40) NULL,
  data        JSON NULL,
  read_at     DATETIME(3) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_notif_user (user_id, id),
  INDEX idx_notif_unread (user_id, read_at)
);
