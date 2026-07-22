<?php
declare(strict_types=1);

/**
 * Seeds a newly created user's personal Dashboard shelf with every tile marked
 * is_default in dashboard_apps. Called by auth-controller.php right after the
 * INSERT INTO users on first sign-in.
 *
 * Deliberately seeds ALL defaults, including gated and inactive ones: the
 * shelf query filters by permission and tile active-ness, so such rows lie
 * dormant and the tile appears the moment a role is granted (or the tile is
 * re-activated), with no extra step for the user. Seeded rows keep the default
 * folder_id NULL and position 0, so a brand-new shelf follows catalog
 * sort_order until the user arranges it.
 *
 * Takes the PDO handle as a parameter (rather than using Database::write())
 * so tests can drive it against their own connection.
 */
function seedDefaultDashboardApps(PDO $write, int $userId): void
{
    $write->prepare(
        'INSERT INTO dashboard_user_apps (user_id, app_id)
         SELECT ?, h.id FROM dashboard_apps h WHERE h.is_default = 1
         ON DUPLICATE KEY UPDATE app_id = dashboard_user_apps.app_id'
    )->execute([$userId]);
}
