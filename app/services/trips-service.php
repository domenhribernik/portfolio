<?php
declare(strict_types=1);

require_once __DIR__ . '/image-service.php';

/**
 * Deleting Trips data (views/trips) without leaving files behind.
 *
 * A trip photo is a trips_photos row plus two images rows (display and thumb)
 * plus two files on disk. The foreign keys run images -> trips_photos, so a
 * cascade from a deleted trip or place removes the photo rows but strands the
 * images rows and their files. Every delete therefore goes through here: the
 * images rows first (which cascades the photo rows), then the files once the
 * transaction has committed.
 *
 * Used by trips-controller.php for photo, place and trip deletes, and by
 * auth-controller.php before an account is deleted.
 */
final class TripsService
{
    /** Tombstones older than this are pruned; no offline phone waits that long. */
    private const TOMBSTONE_DAYS = 180;

    /**
     * id, uuid, folder and mime of both images of every photo matching a
     * WHERE clause over trips_photos aliased p. The clause is always a
     * literal from this codebase; values go in $params.
     */
    public static function imageRowsFor(PDO $db, string $where, array $params): array
    {
        $stmt = $db->prepare("SELECT i.id, i.uuid, i.folder, i.mime_type
            FROM trips_photos p
            JOIN images i ON i.id IN (p.image_id, p.thumb_image_id)
            WHERE $where");
        $stmt->execute($params);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /** Uuids of the photos matching a WHERE clause over trips_photos aliased p. */
    public static function photoUuidsFor(PDO $db, string $where, array $params): array
    {
        $stmt = $db->prepare("SELECT p.uuid FROM trips_photos p WHERE $where");
        $stmt->execute($params);
        return $stmt->fetchAll(PDO::FETCH_COLUMN);
    }

    /** Deletes the images rows, which cascades their photo rows. Inside the caller's transaction. */
    public static function deleteImageRows(PDO $db, array $rows): void
    {
        foreach (array_chunk(array_column($rows, 'id'), 500) as $ids) {
            $marks = implode(',', array_fill(0, count($ids), '?'));
            $db->prepare("DELETE FROM images WHERE id IN ($marks)")->execute(array_map('intval', $ids));
        }
    }

    /** Removes the files. After commit: a rolled-back delete must still have them. */
    public static function removeFiles(array $rows): void
    {
        foreach ($rows as $row) {
            try {
                ImageService::remove($row['uuid'], $row['folder'], $row['mime_type']);
            } catch (\Throwable $e) {
                // remove() throws for a file that is already missing; the row
                // is gone either way, which is what matters.
                error_log('trips-service: could not remove ' . $row['uuid'] . ': ' . $e->getMessage());
            }
        }
    }

    /** Records deleted uuids so a queued create cannot bring them back. */
    public static function tombstone(PDO $db, string $kind, array $uuids): void
    {
        $stmt = $db->prepare('INSERT IGNORE INTO trips_tombstones (uuid, kind) VALUES (?, ?)');
        foreach ($uuids as $uuid) {
            $stmt->execute([$uuid, $kind]);
        }
        $db->prepare('DELETE FROM trips_tombstones WHERE deleted_at < NOW() - INTERVAL ' . self::TOMBSTONE_DAYS . ' DAY')
            ->execute();
    }

    /**
     * Before an account is deleted: the files of every photo in every trip it
     * owns, including photos its travellers added, since those trips go with
     * the account. Photos it added to other people's trips stay there; the
     * foreign key sets their uploaded_by to NULL.
     *
     * A deployment without the trips tables is skipped. Anything else throws,
     * so the account is not deleted with files still on disk.
     */
    public static function purgeUser(PDO $db, int $userId): void
    {
        try {
            $rows = self::imageRowsFor($db, 'p.trip_id IN (SELECT id FROM trips WHERE owner_id = ?)', [$userId]);
        } catch (PDOException $e) {
            if ($e->getCode() === '42S02') return;
            throw $e;
        }
        if (!$rows) return;

        $db->beginTransaction();
        try {
            self::deleteImageRows($db, $rows);
            $db->commit();
        } catch (\Throwable $e) {
            $db->rollBack();
            throw $e;
        }
        self::removeFiles($rows);
    }
}
