-- Shared lists (views/list).
--
-- Run manually in phpMyAdmin, like all SQL in this repo. This file is the
-- CURRENT schema, for a fresh install. An existing database is brought here by
-- app/models/seeds/list-rework-2026-09.sql instead, which migrates in place.
--
-- Requires auth-model.sql (users, projects, user_project_roles) first.

CREATE TABLE IF NOT EXISTS list_collections (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- updated_at is DATETIME(3), not DATETIME, and that is load-bearing: the poll
-- version is COUNT + MAX(updated_at), so at one-second granularity a check
-- landing in the same second as the previous write produced a byte-identical
-- version and every poller short-circuited past it. The checkmark then never
-- reached the other phone until something else changed. Milliseconds make two
-- separate requests collide only in theory.
CREATE TABLE IF NOT EXISTS list_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    collection_id INT NOT NULL,
    name VARCHAR(255) NOT NULL,
    checked TINYINT(1) NOT NULL DEFAULT 0,
    checked_at DATETIME(3) DEFAULT NULL,
    checked_by VARCHAR(64) DEFAULT NULL,
    checked_by_user_id INT DEFAULT NULL,
    added_by VARCHAR(64) DEFAULT NULL,
    added_by_user_id INT DEFAULT NULL,
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_li_collection (collection_id, checked),
    INDEX idx_li_updated_at (updated_at),
    CONSTRAINT fk_li_collection FOREIGN KEY (collection_id)
        REFERENCES list_collections(id) ON DELETE CASCADE,
    CONSTRAINT fk_li_added_by FOREIGN KEY (added_by_user_id)
        REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_li_checked_by FOREIGN KEY (checked_by_user_id)
        REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Labels belong to a collection, so two lists never share a vocabulary. Exactly
-- two kinds exist and the set is closed: `section` is where it sits in the shop
-- (an item has 0 or 1), `shop` is where to buy it (an item has 0 or many).
-- name_key is the lowercased, whitespace-collapsed name, and it is what the
-- uniqueness constraint and every lookup use.
CREATE TABLE IF NOT EXISTS list_labels (
    id INT AUTO_INCREMENT PRIMARY KEY,
    collection_id INT NOT NULL,
    kind ENUM('section', 'shop') NOT NULL,
    name VARCHAR(40) NOT NULL,
    name_key VARCHAR(40) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    created_by INT DEFAULT NULL,
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_ll_collection_kind_key (collection_id, kind, name_key),
    INDEX idx_ll_collection (collection_id, kind, sort_order),
    CONSTRAINT fk_ll_collection FOREIGN KEY (collection_id)
        REFERENCES list_collections(id) ON DELETE CASCADE,
    CONSTRAINT fk_ll_created_by FOREIGN KEY (created_by)
        REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS list_item_labels (
    item_id INT NOT NULL,
    label_id INT NOT NULL,
    PRIMARY KEY (item_id, label_id),
    INDEX idx_lil_label (label_id),
    CONSTRAINT fk_lil_item FOREIGN KEY (item_id)
        REFERENCES list_items(id) ON DELETE CASCADE,
    CONSTRAINT fk_lil_label FOREIGN KEY (label_id)
        REFERENCES list_labels(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What was actually bought, written when checked items are archived. The label
-- columns are TEXT SNAPSHOTS on purpose, not foreign keys: history must survive
-- someone renaming or deleting a label, and it must still read correctly years
-- later. Same reasoning for the *_by name columns beside the user ids, which go
-- NULL when an account is deleted while the trip itself stays readable.
CREATE TABLE IF NOT EXISTS list_purchases (
    id INT AUTO_INCREMENT PRIMARY KEY,
    collection_id INT NOT NULL,
    name VARCHAR(255) NOT NULL,
    name_key VARCHAR(255) NOT NULL,
    section VARCHAR(40) DEFAULT NULL,
    shops VARCHAR(255) DEFAULT NULL,
    added_by VARCHAR(64) DEFAULT NULL,
    added_by_user_id INT DEFAULT NULL,
    bought_by VARCHAR(64) DEFAULT NULL,
    bought_by_user_id INT DEFAULT NULL,
    added_at DATETIME(3) DEFAULT NULL,
    bought_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_lp_collection_bought (collection_id, bought_at),
    INDEX idx_lp_collection_key (collection_id, name_key),
    CONSTRAINT fk_lp_collection FOREIGN KEY (collection_id)
        REFERENCES list_collections(id) ON DELETE CASCADE,
    CONSTRAINT fk_lp_added_by FOREIGN KEY (added_by_user_id)
        REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_lp_bought_by FOREIGN KEY (bought_by_user_id)
        REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Row-level access control: which users can see which collection.
-- Layered on top of the auth system (see views/admin/CLAUDE.md for the
-- pattern). Site admins bypass this table entirely.
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
