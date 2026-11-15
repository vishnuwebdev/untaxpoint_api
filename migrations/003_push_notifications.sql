-- Push notifications (Firebase Cloud Messaging).
-- 1) Device tokens: one row per phone/app install, linked to the signed-in member.
CREATE TABLE device_tokens (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id       VARCHAR(40) NOT NULL,
  token         VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  platform      VARCHAR(16) NOT NULL,
  app_version   VARCHAR(32) NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_device_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_device_token (token),
  INDEX idx_device_user (user_id)
);

-- 2) Every in-app notification is also pushed once. The push worker picks rows with pushed_at IS NULL.
ALTER TABLE notifications
  ADD COLUMN pushed_at DATETIME(3) NULL,
  ADD COLUMN push_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  ADD INDEX idx_notif_push (pushed_at, id);

-- Existing notifications are history: never push them.
UPDATE notifications SET pushed_at = created_at WHERE pushed_at IS NULL;
