-- Push notifications (Firebase Cloud Messaging).
-- Written so it is safe to run on a database where part of it already exists
-- (e.g. a server that was set up from a SQL dump): every step checks first.

-- 1) Device tokens: one row per phone/app install, linked to the signed-in member.
CREATE TABLE IF NOT EXISTS device_tokens (
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
--    MySQL 8.0 has no "ADD COLUMN IF NOT EXISTS", so each step checks information_schema first.
SET @had_pushed_at := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'pushed_at');
SET @sql := IF(@had_pushed_at = 0, 'ALTER TABLE notifications ADD COLUMN pushed_at DATETIME(3) NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'push_attempts') = 0,
  'ALTER TABLE notifications ADD COLUMN push_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF((SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications' AND INDEX_NAME = 'idx_notif_push') = 0,
  'ALTER TABLE notifications ADD INDEX idx_notif_push (pushed_at, id)', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Existing notifications are history: never push them (only when pushed_at was just added).
SET @sql := IF(@had_pushed_at = 0, 'UPDATE notifications SET pushed_at = created_at WHERE pushed_at IS NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
