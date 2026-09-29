-- Time Tracking System schema
CREATE DATABASE IF NOT EXISTS timetracking CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE timetracking;

CREATE TABLE IF NOT EXISTS projects (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50) DEFAULT NULL,
    color VARCHAR(7) NOT NULL DEFAULT '#3d5a80',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS time_entries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    project_id INT NOT NULL,
    work_date DATE NOT NULL,
    hours DECIMAL(5,2) NOT NULL DEFAULT 0,
    notes VARCHAR(500) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_project_date (project_id, work_date),
    CONSTRAINT fk_entries_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS settings (
    setting_key VARCHAR(100) PRIMARY KEY,
    setting_value VARCHAR(255) NOT NULL
) ENGINE=InnoDB;

INSERT INTO settings (setting_key, setting_value) VALUES
    ('week_start_day', '1'),
    ('max_hours_per_day', '8'),
    ('max_hours_per_week', '40'),
    ('hour_increment', '0.25'),
    ('require_notes', '0'),
    ('default_range_days', '7'),
    ('allow_future_dates', '0'),
    ('include_weekends', '1'),
    ('timezone', 'America/New_York')
ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value);

INSERT INTO projects (name, code, color, is_active, sort_order)
SELECT * FROM (
    SELECT 'Internal Operations' AS name, 'OPS' AS code, '#3d5a80' AS color, 1 AS is_active, 1 AS sort_order
    UNION ALL SELECT 'Client Delivery', 'CLIENT', '#2a9d8f', 1, 2
    UNION ALL SELECT 'Research & Development', 'RND', '#e9c46a', 1, 3
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM projects LIMIT 1);
