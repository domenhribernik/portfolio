-- Hub launcher tiles. Per-user visibility rides the auth projects registry:
-- a tile linked to a project is shown only to users holding a role in it
-- (site admins see everything); a tile with project_id NULL is shown to any
-- signed-in user. The hub is navigation, not a security boundary: every
-- target view enforces its own auth.
-- Run manually in phpMyAdmin. Safe to re-run.

CREATE TABLE IF NOT EXISTS hub_apps (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    icon VARCHAR(100) NOT NULL DEFAULT 'fa-solid fa-cube',
    gradient VARCHAR(255) NOT NULL DEFAULT 'linear-gradient(45deg, #d4451f 0%, #f2b705 100%)',
    url VARCHAR(255) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    project_id INT DEFAULT NULL,
    active TINYINT NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_hub_apps_sort (active, sort_order),
    CONSTRAINT fk_hub_apps_project FOREIGN KEY (project_id)
        REFERENCES projects(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Register the linked projects if missing (auth-model.sql seed pattern).
INSERT INTO projects (project_key, name) VALUES
    ('botaniq',   'Botaniq'),
    ('sourdough', 'Sourdough'),
    ('list',      'Lists'),
    ('vrata',     'Vrata')
ON DUPLICATE KEY UPDATE name = name;

-- Seed tiles. INSERT ... SELECT resolves project ids by key at run time;
-- UNIQUE(name) makes re-runs no-ops. Urls are root-relative: the hub
-- frontend resolves them against the site root, so they work whether the
-- site is served at / or under /portfolio/.
INSERT INTO hub_apps (name, icon, gradient, url, sort_order, project_id)
SELECT 'Botaniq', 'fa-solid fa-leaf',
       'linear-gradient(45deg, #2d6a4f 0%, #74c69d 100%)', '/views/botaniq/', 10, p.id
FROM projects p WHERE p.project_key = 'botaniq'
ON DUPLICATE KEY UPDATE hub_apps.name = hub_apps.name;

INSERT INTO hub_apps (name, icon, gradient, url, sort_order, project_id)
SELECT 'Sourdough', 'fa-solid fa-bread-slice',
       'linear-gradient(45deg, #b8371a 0%, #f2b705 100%)', '/views/sourdough/', 20, p.id
FROM projects p WHERE p.project_key = 'sourdough'
ON DUPLICATE KEY UPDATE hub_apps.name = hub_apps.name;

INSERT INTO hub_apps (name, icon, gradient, url, sort_order, project_id)
SELECT 'Lists', 'fa-solid fa-list-check',
       'linear-gradient(45deg, #1f35e0 0%, #4facfe 100%)', '/views/list/', 30, p.id
FROM projects p WHERE p.project_key = 'list'
ON DUPLICATE KEY UPDATE hub_apps.name = hub_apps.name;

INSERT INTO hub_apps (name, icon, gradient, url, sort_order, project_id)
SELECT 'Vrata', 'fa-solid fa-door-open',
       'linear-gradient(45deg, #1c1a17 0%, #6b6256 100%)', '/views/vrata/', 40, p.id
FROM projects p WHERE p.project_key = 'vrata'
ON DUPLICATE KEY UPDATE hub_apps.name = hub_apps.name;
