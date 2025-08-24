

CREATE DATABASE IF NOT EXISTS otp_system;
USE otp_system;

-- Main OTP table with single active OTP constraint
CREATE TABLE otps (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    purpose VARCHAR(100) NOT NULL,
    code CHAR(6) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    is_used BOOLEAN DEFAULT FALSE,
    is_locked BOOLEAN DEFAULT FALSE,
    locked_until TIMESTAMP NULL,
    attempt_count INT DEFAULT 0,
    
    -- Enforce single active OTP per (user_id, purpose)
    UNIQUE KEY uk_user_purpose_active (user_id, purpose, is_used, is_locked),
    
    INDEX idx_user_purpose (user_id, purpose),
    INDEX idx_expires_at (expires_at),
    INDEX idx_cleanup (is_used, expires_at)
);

-- Rate limiting table for per-user requests
CREATE TABLE user_rate_limits (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    request_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_user_timestamp (user_id, request_timestamp)
);

-- Rate limiting table for per-IP requests  
CREATE TABLE ip_rate_limits (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    ip_address VARCHAR(45) NOT NULL, -- IPv6 compatible
    request_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_ip_timestamp (ip_address, request_timestamp)
);

-- Idempotency table for /otp/request
CREATE TABLE idempotency_keys (
    idempotency_key VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    purpose VARCHAR(100) NOT NULL,
    response_data JSON NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    
    INDEX idx_expires_at (expires_at)
);


-- Cleanup procedure (can be called manually since no cron allowed)
DELIMITER //
CREATE PROCEDURE CleanupExpiredData()
BEGIN
    -- Clean expired OTPs
    DELETE FROM otps WHERE expires_at < NOW() OR (is_used = TRUE AND created_at < NOW() - INTERVAL 1 DAY);
    
    -- Clean old rate limit records (keep 15 minutes)
    DELETE FROM user_rate_limits WHERE request_timestamp < NOW() - INTERVAL 15 MINUTE;
    DELETE FROM ip_rate_limits WHERE request_timestamp < NOW() - INTERVAL 15 MINUTE;
    
    -- Clean expired idempotency keys
    DELETE FROM idempotency_keys WHERE expires_at < NOW();
END //
DELIMITER ;