# views/recipes

Public recipe collection, and the reference for the **public catalog plus login-gated own
rows** shape (root CLAUDE.md, "Authentication and Permissions"). Different from the
botaniq demo shape: reads here list *everyone's* rows, not one owner's.

Backend [app/controllers/recipes-controller.php](../../app/controllers/recipes-controller.php),
schema [app/models/recipes-model.sql](../../app/models/recipes-model.sql). Pure logic in
[logic.js](logic.js), tested by
[tests/recipes-logic.test.mjs](../../tests/recipes-logic.test.mjs).

## The shape

- **Reads are public and list every user's recipes.** No project role, no login.
- **Writes need only `Auth::requireLogin()`** and are scoped `AND user_id = ?`, so a
  signed-in user can only touch their own. The payload carries a `mine` boolean per row so
  the UI knows what it may edit.

**Author names never expose the email.** The list query joins
`COALESCE(NULLIF(u.display_name, ''), NULLIF(u.username, ''), 'Anonymous') AS author`.
Keep that shape when adding queries here, a bare join to `users` would leak addresses into
a public endpoint.

## Invariants

- **The whole recipe document saves atomically in one transaction.** Child rows
  (`recipe_ingredients`, `recipe_steps`) are **deleted and rewritten wholesale** on every
  save, so their ids are unstable and nothing may reference them. Same pattern as
  `workout_items`.
- **Per-user ratings upsert** against `UNIQUE KEY uq_rr_recipe_user (recipe_id, user_id)`,
  one rating per person per recipe.
- Ingredients are keyed by `UNIQUE KEY uq_ri_recipe_key (recipe_id, ing_key)`.
- `recipes.servings` is **nullable** (optional base serving count, 1-100). When set, the
  page rescales ingredient quantities live. Null means the recipe simply has no scaling
  UI, it is not an error state, so don't `COALESCE` it to 1.
- Images go through the shared `images` table via `image_id`, never duplicated columns
  (root CLAUDE.md, "Adding a New Project").
