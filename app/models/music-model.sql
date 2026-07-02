CREATE TABLE IF NOT EXISTS music_sync (
    id INT AUTO_INCREMENT PRIMARY KEY,
    track_key VARCHAR(255) NOT NULL UNIQUE,
    lyrics TEXT NOT NULL,
    chords JSON NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- track_key is "<category>/<file name>", e.g. "acoustic/Wonderwall - Oasis.mp3".
-- chords stores either a plain JSON array of chord events sorted by time
-- (legacy rows) or, once the editor saves word syncs, an envelope:
--   [{ "time": 12.4, "chord": "Am", "line": 2, "word": 3 }, ...]      (plain)
--   { "events": [ ...as above... ],
--     "words":  [{ "time": 13.1, "line": 2, "word": 4 }, ...] }       (envelope)
-- "line"/"word" are optional 0-based anchors into the lyrics text; events
-- without an anchor still drive the "current chord" badge during playback.
-- Word syncs are chord-less timestamps for single lyric words, used by the
-- player to interpolate the karaoke highlight; the API always exposes them
-- as a separate "words" array in both directions.

CREATE TABLE IF NOT EXISTS music_analyses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    filename VARCHAR(255) NOT NULL,
    result JSON NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- result is the full JSON payload returned by app/scripts/analyze_audio.py.
