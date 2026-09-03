<?php
declare(strict_types=1);
// BEARING / how an animal moves.
//
// THE POINT OF THIS FILE. An animal used to hash its way to a random
// direction every cycle. A random walk is unpredictable in the useless
// sense: no number of fixes tells you anything about the next one, so
// gathering data was busywork and the pair had nothing to reason about.
//
// Each collar now carries one of four hidden behaviour profiles, assigned
// at seed time and never published until dawn. A profile is a SHAPE, and a
// shape is legible from three or four fixes IF those fixes are tight. That
// is the whole skill chain: bracket well, get a tight fix, see the shape,
// predict where she goes, and put a body there before she arrives.
//
// Pure: no database, no output. tests/bearing-sim.test.php calls straight
// into it and that is what arbitrates whether the shapes are actually
// distinguishable rather than merely different in the source.

require_once __DIR__ . '/valley.php';

const PROFILES = ['ridge', 'den', 'water', 'flight'];

// Cells per cycle. Kept low because fixes land three or so cycles apart,
// so the per-fix displacement is roughly three times these numbers and a
// 32 cell valley is not large.
const PACE = ['ridge' => 2, 'den' => 2, 'water' => 2, 'flight' => 4];

// How tightly a den animal orbits. Small enough that three fixes three
// cycles apart walk most of the way round it, which is what makes the
// curl visible instead of merely present.
const DEN_R = 3.5;

// Bounds an animal stays inside, so nothing walks off the plate and out of
// the game. The intercept has to stay winnable.
const INNER = 2;

/** Two collars, two different profiles, both fixed by the seed. */
function assignProfiles(int $seed, int $count): array {
    $pool = PROFILES;
    $out = [];
    for ($i = 0; $i < $count; $i++) {
        $pick = (int)floor(hash32($seed + $i * 6151 + 17) * count($pool)) % count($pool);
        $out[] = $pool[$pick];
        array_splice($pool, $pick, 1);          // no night runs the same shape twice
        if (!$pool) $pool = PROFILES;
    }
    return $out;
}

function clampInner(int $v): int { return max(INNER, min(N - 1 - INNER, $v)); }

/** Walk a cell downhill or uphill to a local extreme. How a water animal
    picks the next place worth standing in, and where a ridge runner and
    her whole night begin. */
function slopeWalk(string $terrain, int $x, int $y, int $steps, int $dir): array {
    for ($s = 0; $s < $steps; $s++) {
        $bestX = $x; $bestY = $y; $best = elevAt($terrain, $x, $y);
        for ($dy = -1; $dy <= 1; $dy++) for ($dx = -1; $dx <= 1; $dx++) {
            if ($dx === 0 && $dy === 0) continue;
            $nx = clampInner($x + $dx); $ny = clampInner($y + $dy);
            $e = elevAt($terrain, $nx, $ny);
            if ($dir < 0 ? $e < $best : $e > $best) { $best = $e; $bestX = $nx; $bestY = $ny; }
        }
        if ($bestX === $x && $bestY === $y) break;
        $x = $bestX; $y = $bestY;
    }
    return [$x, $y];
}
function descend(string $t, int $x, int $y, int $n): array { return slopeWalk($t, $x, $y, $n, -1); }
function ascend(string $t, int $x, int $y, int $n): array { return slopeWalk($t, $x, $y, $n, 1); }

/** Where a collar starts the night. A ridge runner starts on a ridge and a
    water animal starts in the wet, because a profile that has to walk half
    the valley before it looks like itself is not readable in ten cycles. */
function bearingStart(string $terrain, string $profile, int $seed, int $index): int {
    $salt = $seed + $index * 7717;
    // a margin past INNER, so a den animal never orbits a point pinned to
    // the valley edge with half her circle outside the plate
    $m = INNER + 3;
    $x = $m + (int)floor(hash32($salt + 733) * (N - 2 * $m));
    $y = $m + (int)floor(hash32($salt + 977) * (N - 2 * $m));
    if ($profile === 'ridge')  [$x, $y] = ascend($terrain, $x, $y, 14);
    if ($profile === 'water')  [$x, $y] = descend($terrain, $x, $y, 14);
    if ($profile === 'flight') {
        // out near an edge, so a straight runner has the whole valley to cross
        $edge = (int)floor(hash32($salt + 401) * 4);
        if ($edge === 0) $y = INNER + 1;
        elseif ($edge === 1) $y = N - 2 - INNER;
        elseif ($edge === 2) $x = INNER + 1;
        else $x = N - 2 - INNER;
    }
    return cellIndex($x, $y);
}

/** Step `dist` along `deg` from a cell, as integer cell coordinates. */
function stepAlong(int $x, int $y, float $deg, float $dist): array {
    $a = ($deg - 90) * M_PI / 180;
    return [(int)round($x + cos($a) * $dist), (int)round($y + sin($a) * $dist)];
}

/** Where a collar is next cycle. The one function the whole redesign turns
    on, so every branch here is a shape a player is meant to be able to read
    off four crosses on a plate. */
function bearingStep(string $terrain, string $profile, int $at, ?int $denCell,
                     int $cycle, int $seed, string $collar, array $stations): int {
    [$x, $y] = cellXY($at);
    $salt = $seed + crc32($collar);
    $pace = PACE[$profile] ?? 2;

    if ($profile === 'ridge') {
        // A fixed heading held all night, but always taking the highest
        // ground on offer within a wide cone of it. Reads as a near
        // monotone track that stays up on the tops.
        // A wide forward cone at two step lengths, so she can follow a ridge
        // that bends instead of marching off the side of it. The heading
        // only stops her doubling back; the ground chooses the rest.
        $heading = hash32($salt + 11) * 360;
        $bestX = $x; $bestY = $y; $best = -99.0;
        foreach ([$pace, $pace - 1] as $reach) {
            if ($reach < 1) continue;
            for ($k = -3; $k <= 3; $k++) {
                [$nx, $ny] = stepAlong($x, $y, $heading + $k * 29, (float)$reach);
                $nx = clampInner($nx); $ny = clampInner($ny);
                if ($nx === $x && $ny === $y) continue;
                $e = elevAt($terrain, $nx, $ny) - abs($k) * 0.12;   // ties break straight ahead
                if ($e > $best) { $best = $e; $bestX = $nx; $bestY = $ny; }
            }
        }
        return cellIndex($bestX, $bestY);
    }

    if ($profile === 'den') {
        // Orbits a hidden den. Outside the radius she comes home, inside it
        // she circles, so the track curves back on itself and never leaves
        // a small patch. That bounded spread is the tell.
        $den = $denCell ?? $at;
        [$dx, $dy] = cellXY($den);
        $r = sqrt(pow($x - $dx, 2) + pow($y - $dy, 2));
        $spin = hash32($salt + 29) > 0.5 ? 1 : -1;
        if ($r < 0.5) {
            // The cycle MUST be in this salt. Without it she picked the same
            // heading every cycle, and a den sitting against the valley edge
            // clamped straight back onto itself: nineteen collars in four
            // hundred seeds froze solid for the whole night.
            [$nx, $ny] = stepAlong($x, $y, hash32($salt + 61 + $cycle * 313) * 360, (float)$pace);
            return cellIndex(clampInner($nx), clampInner($ny));
        }
        // Always tangential, with the radius corrected gently rather than
        // by heading home. Running for the den whenever she drifted wide
        // made her oscillate through the middle and cancel her own arc, so
        // the curl that is supposed to be her whole tell averaged out flat.
        $out = bearingBetween([$dx, $dy], [$x, $y]);
        $correct = max(-50.0, min(50.0, ($r - DEN_R) * 25));
        [$nx, $ny] = stepAlong($x, $y, $out + $spin * (90 + $correct), (float)$pace);
        return cellIndex(clampInner($nx), clampInner($ny));
    }

    if ($profile === 'water') {
        // Traverses between low places and lingers when she arrives. The
        // target changes every third cycle, so arriving early buys a cycle
        // of standing still: short, uneven steps down in the valley floor.
        // The target must depend on the LEG, never on where she currently
        // stands. Recomputing it from her own position every cycle meant she
        // was always walking toward something two cells further on, so she
        // never arrived, never lingered, and the short uneven step that is
        // her whole signature never appeared.
        $leg = intdiv($cycle, 3);
        $ax = clampInner((int)floor(hash32($salt + $leg * 3571 + 101) * N));
        $ay = clampInner((int)floor(hash32($salt + $leg * 7919 + 5) * N));
        $tx = $ax; $ty = $ay; $best = 99.0;
        for ($oy = -6; $oy <= 6; $oy++) for ($ox = -6; $ox <= 6; $ox++) {
            $cx2 = clampInner($ax + $ox); $cy2 = clampInner($ay + $oy);
            $e = elevAt($terrain, $cx2, $cy2);
            if ($e < $best) { $best = (float)$e; $tx = $cx2; $ty = $cy2; }
        }
        $d = sqrt(pow($tx - $x, 2) + pow($ty - $y, 2));
        if ($d < 1.2) return $at;                        // arrived: linger
        [$nx, $ny] = stepAlong($x, $y, bearingBetween([$x, $y], [$tx, $ty]), (float)min($pace, $d));
        return cellIndex(clampInner($nx), clampInner($ny));
    }

    // flight: long consistent steps that veer off anyone standing in the
    // way, and steer rather than bounce at the valley edge so a straight
    // runner never simply leaves the game.
    $heading = hash32($salt + 3) * 360 + $cycle * 3;
    foreach ($stations as $s) {
        [$sx, $sy] = cellXY((int)$s);
        if (sqrt(pow($sx - $x, 2) + pow($sy - $y, 2)) < 7) {
            $heading = bearingBetween([$sx, $sy], [$x, $y]);
            break;
        }
    }
    $spin = hash32($salt + 97) > 0.5 ? 1 : -1;
    for ($try = 0; $try < 12; $try++) {
        [$nx, $ny] = stepAlong($x, $y, $heading + $spin * $try * 18, (float)$pace);
        if ($nx >= INNER && $ny >= INNER && $nx <= N - 1 - INNER && $ny <= N - 1 - INNER) {
            return cellIndex($nx, $ny);
        }
    }
    [$nx, $ny] = stepAlong($x, $y, $heading, (float)$pace);
    return cellIndex(clampInner($nx), clampInner($ny));
}

/* ------------------------------------------------------- reading a track */

/** The four numbers a track's shape comes down to. Deliberately the same
    things a person reads off the plate: how far she goes between fixes,
    how straight she runs, how much ground she covers at all, and how high
    she stays. No profile is consulted, so this cannot flatter the model. */
function trackFeatures(string $terrain, array $cells, array $cycles): array {
    $n = count($cells);
    if ($n < 2) return ['step' => 0.0, 'straight' => 0.0, 'spread' => 0.0, 'elev' => 0.0];
    $path = 0.0; $step = 0.0; $legs = 0;
    for ($i = 1; $i < $n; $i++) {
        [$ax, $ay] = cellXY($cells[$i - 1]); [$bx, $by] = cellXY($cells[$i]);
        $d = sqrt(pow($bx - $ax, 2) + pow($by - $ay, 2));
        $gap = max(1, $cycles[$i] - $cycles[$i - 1]);
        $path += $d; $step += $d / $gap; $legs++;
    }
    [$fx, $fy] = cellXY($cells[0]); [$lx, $ly] = cellXY($cells[$n - 1]);
    $net = sqrt(pow($lx - $fx, 2) + pow($ly - $fy, 2));

    $cx = 0.0; $cy = 0.0; $elev = 0.0;
    foreach ($cells as $c) {
        [$px, $py] = cellXY($c);
        $cx += $px; $cy += $py; $elev += elevAt($terrain, $px, $py);
    }
    $cx /= $n; $cy /= $n; $elev /= $n;
    $spread = 0.0;
    foreach ($cells as $c) {
        [$px, $py] = cellXY($c);
        $spread = max($spread, sqrt(pow($px - $cx, 2) + pow($py - $cy, 2)));
    }
    // Height RELATIVE TO THIS VALLEY, not in absolute digits. One seed's
    // ridge is another seed's valley floor, so a raw elevation carries the
    // terrain's own spread as noise and measured almost nothing. The rank
    // asks the only question that transfers: of all the ground here, how
    // much of it is below her?
    $below = 0;
    for ($i = 0; $i < N * N; $i++) if ((int)$terrain[$i] < $elev) $below++;

    return [
        'step'     => $step / $legs,
        'straight' => $path > 0.001 ? $net / $path : 0.0,
        'spread'   => $spread,
        'elev'     => $elev,
        'high'     => $below / (N * N),
    ];
}

// Where each profile sits in feature space, as [mean, sd] per feature.
// MEASURED off the real movement model over four hundred seeds, never
// guessed: the means and deviations are what the shapes actually do.
//
// Two things this calibration taught, both worth keeping:
//
// A single shared scale was wrong. A den's spread varies by about one cell
// across seeds and a flight's by three and a half, so one number flattered
// the tight class and punished the loose one.
//
// `straight` measured useless until the den animal actually orbited. While
// she was oscillating in and out of her den her arc cancelled itself out
// and every profile came back equally straight, which is a good reminder
// that a feature carrying no signal is usually a broken model rather than
// a bad idea.
const PROTOTYPE = [
    'ridge'  => ['step' => [1.12, 0.60], 'straight' => [0.76, 0.37], 'spread' => [3.38, 1.91], 'high' => [0.69, 0.21]],
    'den'    => ['step' => [1.27, 0.63], 'straight' => [0.65, 0.24], 'spread' => [2.89, 1.17], 'high' => [0.45, 0.25]],
    'water'  => ['step' => [1.40, 0.43], 'straight' => [0.86, 0.20], 'spread' => [4.13, 1.42], 'high' => [0.27, 0.21]],
    'flight' => ['step' => [2.86, 1.01], 'straight' => [0.78, 0.32], 'spread' => [8.24, 3.36], 'high' => [0.53, 0.21]],
];

/** Which shape best explains this track, scored as independent Gaussians
    per feature. Returns the profile and the margin over the runner-up,
    which is what says whether the track was actually legible or merely
    closest to something. */
function classifyTrack(string $terrain, array $cells, array $cycles): array {
    $f = trackFeatures($terrain, $cells, $cycles);
    $scored = [];
    foreach (PROTOTYPE as $name => $p) {
        $nll = 0.0;
        foreach ($p as $k => [$mean, $sd]) {
            $nll += pow(($f[$k] - $mean) / $sd, 2) / 2 + log($sd);
        }
        $scored[$name] = $nll;
    }
    asort($scored);
    $names = array_keys($scored);
    $vals = array_values($scored);
    return ['profile' => $names[0], 'margin' => $vals[1] - $vals[0], 'features' => $f, 'scores' => $scored];
}
