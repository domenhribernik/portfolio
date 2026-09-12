-- views/list rework (2026-09): labels, attribution, purchase history.
--
-- Migrates an EXISTING list database in place. A fresh install runs
-- app/models/list-model.sql instead and needs none of this.
--
-- Run manually in phpMyAdmin, top to bottom, in one go. Every statement is
-- safe to re-run EXCEPT the ALTER/DROP ones, which error harmlessly ("duplicate
-- column", "can't DROP") if the migration already ran. If one of those errors,
-- the migration is already applied; stop.
--
-- Rehearsed against the local scratch DB before shipping. Until it is applied,
-- every read of views/list 500s, because the controller now joins on
-- list_items.collection_id.

-- ------------------------------------------------------------------
-- 1. New columns on list_items.
--    updated_at/created_at go to millisecond precision: the poll version is
--    COUNT + MAX(updated_at), and at one-second granularity a check landing in
--    the same second as the previous write left the version byte-identical, so
--    pollers short-circuited and the checkmark never reached the other phone.
-- ------------------------------------------------------------------

ALTER TABLE list_items
    ADD COLUMN collection_id INT NULL AFTER id,
    ADD COLUMN checked_at DATETIME(3) NULL AFTER checked,
    ADD COLUMN checked_by VARCHAR(64) NULL AFTER checked_at,
    ADD COLUMN checked_by_user_id INT NULL AFTER checked_by,
    ADD COLUMN added_by_user_id INT NULL AFTER added_by,
    MODIFY COLUMN created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
    MODIFY COLUMN updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);

-- ------------------------------------------------------------------
-- 2. Collections that only ever existed as a name on an item.
--    The old schema let an item name a collection with no row of its own
--    (createItem inserted the collection, but older rows predate that).
-- ------------------------------------------------------------------

INSERT IGNORE INTO list_collections (name)
SELECT DISTINCT collection FROM list_items WHERE collection IS NOT NULL AND collection <> '';

-- ------------------------------------------------------------------
-- 3. Point every item at its collection row, then make the link mandatory.
-- ------------------------------------------------------------------

UPDATE list_items i
JOIN list_collections c ON c.name = i.collection
SET i.collection_id = c.id;

-- Orphans cannot exist after step 2, but never let the ALTER below fail on one.
DELETE FROM list_items WHERE collection_id IS NULL;

-- Best-effort backfill of the new attribution columns from what was stored.
-- added_by is a display-name/email label, so match on either.
UPDATE list_items i
JOIN users u ON u.display_name = i.added_by OR u.email = i.added_by
SET i.added_by_user_id = u.id
WHERE i.added_by IS NOT NULL AND i.added_by_user_id IS NULL;

-- An already-checked item has no recorded moment; updated_at is the closest
-- truth available and is what the first history archive will use.
UPDATE list_items SET checked_at = updated_at WHERE checked = 1 AND checked_at IS NULL;

ALTER TABLE list_items
    MODIFY COLUMN collection_id INT NOT NULL,
    ADD CONSTRAINT fk_li_collection FOREIGN KEY (collection_id)
        REFERENCES list_collections(id) ON DELETE CASCADE,
    ADD CONSTRAINT fk_li_added_by FOREIGN KEY (added_by_user_id)
        REFERENCES users(id) ON DELETE SET NULL,
    ADD CONSTRAINT fk_li_checked_by FOREIGN KEY (checked_by_user_id)
        REFERENCES users(id) ON DELETE SET NULL;

-- ------------------------------------------------------------------
-- 4. Drop the old name-based link and its index.
-- ------------------------------------------------------------------

ALTER TABLE list_items
    DROP INDEX idx_collection,
    DROP COLUMN collection,
    ADD INDEX idx_li_collection (collection_id, checked);

-- ------------------------------------------------------------------
-- 5. The new tables. Identical to app/models/list-model.sql; kept in both so
--    each file stands alone. tests/list-controller.test.php applies whichever
--    the scratch DB needs and then exercises the result, so the two cannot
--    drift silently.
-- ------------------------------------------------------------------

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

-- ------------------------------------------------------------------
-- 6. Nothing seeds the trgovina vocabulary. The default sections and shops are
--    a PHP constant, applied per collection from the app's own label manager
--    ("Dodaj privzete oznake"), so a second grocery list gets them the same way.
-- ------------------------------------------------------------------
