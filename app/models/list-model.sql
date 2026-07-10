CREATE TABLE list_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    collection VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,
    checked TINYINT(1) NOT NULL DEFAULT 0,
    added_by VARCHAR(64) DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_collection (collection),
    INDEX idx_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE list_collections (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Row-level access control: which users can see which collection.
-- Layered on top of the auth system (see views/admin/CLAUDE.md for the
-- pattern). Requires auth-model.sql (users, projects, user_project_roles)
-- to have been run first. Site admins bypass this table entirely.
INSERT INTO projects (project_key, name) VALUES ('list', 'Lists')
ON DUPLICATE KEY UPDATE name = name;

CREATE TABLE IF NOT EXISTS list_collection_access (
    id INT AUTO_INCREMENT PRIMARY KEY,
    collection_id INT NOT NULL,
    user_id INT NOT NULL,
    granted_by INT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_lca_collection_user (collection_id, user_id),
    INDEX idx_lca_user (user_id),
    CONSTRAINT fk_lca_collection FOREIGN KEY (collection_id)
        REFERENCES list_collections(id) ON DELETE CASCADE,
    CONSTRAINT fk_lca_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_lca_granted_by FOREIGN KEY (granted_by)
        REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
