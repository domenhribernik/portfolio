-- Recipes: public browsing of everyone's recipes, login-gated authoring and
-- ratings (no project registration; any signed-in user can author, like
-- plants/sourdough). Requires auth-model.sql (users) and images-model.sql
-- (images) to have been run first. Run manually in phpMyAdmin.

CREATE TABLE IF NOT EXISTS recipes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    -- Optional cover photo. Deliberately NULL + ON DELETE SET NULL (not the
    -- usual NOT NULL ... CASCADE image pattern): a recipe is created before
    -- its cover is uploaded and must survive the image row going away.
    image_id INT DEFAULT NULL,
    title VARCHAR(150) NOT NULL,
    description VARCHAR(1000) DEFAULT NULL,
    -- Base serving count ("Serves N"), set by the author. Optional: older
    -- recipes have none, and the cook only gets a scaling control when it is
    -- set. Bounds (1..100) are enforced in the controller.
    servings INT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_recipes_user (user_id),
    CONSTRAINT fk_recipes_user  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
    CONSTRAINT fk_recipes_image FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Existing installs (CREATE TABLE IF NOT EXISTS above only helps fresh ones):
-- add the servings column once. MySQL has no ADD COLUMN IF NOT EXISTS, so run
-- this by hand and ignore the "duplicate column" error if already applied.
-- ALTER TABLE recipes ADD COLUMN servings INT DEFAULT NULL AFTER description;

CREATE TABLE IF NOT EXISTS recipe_ingredients (
    id INT AUTO_INCREMENT PRIMARY KEY,
    recipe_id INT NOT NULL,
    -- Stable per-recipe key assigned by the editor; {ing:K} tokens inside
    -- recipe_steps.body point at this, NOT at the row id (child rows are
    -- rewritten on every save, so ids are not stable across saves).
    ing_key INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    quantity VARCHAR(50) NOT NULL DEFAULT '',
    sort_order INT NOT NULL DEFAULT 0,
    UNIQUE KEY uq_ri_recipe_key (recipe_id, ing_key),
    CONSTRAINT fk_ri_recipe FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS recipe_steps (
    id INT AUTO_INCREMENT PRIMARY KEY,
    recipe_id INT NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    -- Plain text, may contain {ing:K} ingredient tokens.
    body TEXT NOT NULL,
    -- NULL = untimed step. A rest/wait between steps is just a step with a duration.
    duration_seconds INT DEFAULT NULL,
    INDEX idx_rs_recipe (recipe_id),
    CONSTRAINT fk_rs_recipe FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS recipe_ratings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    recipe_id INT NOT NULL,
    user_id INT NOT NULL,
    -- 1..5, validated in the controller.
    stars TINYINT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_rr_recipe_user (recipe_id, user_id),
    INDEX idx_rr_user (user_id),
    CONSTRAINT fk_rr_recipe FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE,
    CONSTRAINT fk_rr_user   FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
