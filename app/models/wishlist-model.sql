-- House wish list (views/wishlist). Requires auth-model.sql (users, projects,
-- user_project_roles) and images-model.sql to have been run first.
--
-- Reads are public. Items are written by a site admin or a user holding the
-- `write` role on the `wishlist` project (grant it from the views/admin
-- dashboard). Claims are anonymous: see wishlist_claims below.

CREATE TABLE IF NOT EXISTS wishlist_items (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(160)  NOT NULL,
    url         VARCHAR(2048) NULL,
    note        TEXT          NULL,
    quantity    TINYINT UNSIGNED NOT NULL DEFAULT 1,
    -- Nullable and SET NULL on purpose, unlike the usual image_id rule: an
    -- item can exist without a picture and must survive losing one.
    image_id    INT           NULL,
    position    INT           NOT NULL DEFAULT 0,
    -- Where an imported item came from (e.g. 'amazon:B07TYMDHCS'). Unique, so
    -- re-running the registry import returns the existing row instead of a twin.
    source_key  VARCHAR(64)   NULL,
    created_by  INT           NULL,
    created_at  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    -- Millisecond precision because the poll version reads MAX(updated_at): two
    -- edits inside one second must still look like a change.
    updated_at  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    -- Soft delete, so the editor's Undo can bring an item back.
    deleted_at  DATETIME      NULL,
    UNIQUE KEY uq_wishlist_items_source (source_key),
    INDEX idx_wishlist_items_order (deleted_at, position, id),
    CONSTRAINT fk_wishlist_items_image FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE SET NULL,
    CONSTRAINT fk_wishlist_items_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per unit someone has said they will bring. A guest needs no account,
-- so the claim is proven by a random token handed to their browser once and
-- stored here only as a SHA-256. No name, no IP: nothing personal is kept.
CREATE TABLE IF NOT EXISTS wishlist_claims (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    item_id     INT         NOT NULL,
    token_hash  CHAR(64)    NOT NULL,
    created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_wishlist_claims_item (item_id),
    CONSTRAINT fk_wishlist_claims_item FOREIGN KEY (item_id) REFERENCES wishlist_items(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO projects (project_key, name) VALUES ('wishlist', 'Wish list')
ON DUPLICATE KEY UPDATE active = 1;
