<?php
declare(strict_types=1);

// BEARING / the balance suite.
//
// THIS IS THE TEST THE REDESIGN RESTS ON. The game's claim is a chain:
// bracket the trace well, get a tight fix, see the animal's shape, predict
// where she goes, and put a body there before she arrives. Every link
// after the first is worthless if the third one does not hold, so this
// suite measures it directly.
//
// It runs the real movement model over hundreds of seeds, takes the three
// fixes a ten cycle night actually affords, and then plays the intercept:
// read the track, guess the shape, call a cell, and measure how far the
// call landed from the animal. The properties under test are:
//
//   a night played with HALF POWER brackets lands more intercepts than the
//   same night played by eyeballing the peak, and
//   reading the shape beats extrapolating in a straight line.
//
// If the first gap closes, the instrument has stopped feeding the game and
// bracketing is decoration. If the second closes, the behaviour profiles
// are decoration. The two error figures below are not invented: they are
// what tests/bearing-logic.test.mjs measures the instrument to deliver.
//
// No database and no server: this suite requires the two pure modules and
// runs the physics directly. Run:
//   /opt/lampp/bin/php tests/bearing-sim.test.php

if (PHP_SAPI !== 'cli') { http_response_code(403); exit('CLI only'); }

require_once __DIR__ . '/../app/controllers/bearing/movement.php';

const SIGMA_BRACKET = 1.45;   // deg RMS, gate at half power
const SIGMA_PEAK    = 4.35;   // deg RMS, eyeballing the top of the lobe
const TRIALS        = 300;
const FIX_CYCLES    = [1, 4, 7];      // what a ten cycle night actually affords per collar
const TARGET_CYCLE  = 9;              // the intercept, two cycles past the last fix
const NIGHT         = 10;
const INTERCEPT_M   = 300;            // INTERCEPT_RADIUS cells, in metres

$passed = 0; $failed = 0;
function check(string $name, bool $cond, string $detail = ''): void {
    global $passed, $failed;
    if ($cond) { $passed++; echo "  ok  $name\n"; }
    else { $failed++; echo "FAIL  $name" . ($detail !== '' ? "  ($detail)" : '') . "\n"; }
}

/** Deterministic standard normal, so a run is reproducible and a failure
    can be walked back to the exact seed that caused it. */
function gauss(int $k): float {
    $u1 = max(1e-9, hash32(($k * 2654435761) & 0x7FFFFFFF));
    $u2 = hash32(($k * 40503 + 12345) & 0x7FFFFFFF);
    return sqrt(-2 * log($u1)) * cos(2 * M_PI * $u2);
}

/** Where two bearings cross, as a cell. Null when they run near parallel,
    which is the geometry refusing to answer rather than a bug. */
function crossFix(array $a, float $da, array $b, float $db): ?int {
    $ax = sin($da * M_PI / 180); $ay = -cos($da * M_PI / 180);
    $bx = sin($db * M_PI / 180); $by = -cos($db * M_PI / 180);
    $det = $ax * $by - $ay * $bx;
    if (abs($det) < 1e-6) return null;
    $dx = $b[0] - $a[0]; $dy = $b[1] - $a[1];
    $t = ($dx * $by - $dy * $bx) / $det;
    $x = (int)round($a[0] + $ax * $t);
    $y = (int)round($a[1] + $ay * $t);
    if ($x < 0 || $y < 0 || $x >= N || $y >= N) return null;
    return cellIndex($x, $y);
}

/** One night: run the animal, take fixes off two noisy bearings, and say
    what the classifier made of the track it left behind. */
function readNight(int $seed, string $profile, float $sigma): ?array {
    $terrain = generateTerrain($seed);
    // A REALISTIC baseline, not the ideal one. Two stations twelve to
    // twenty-four cells apart somewhere in the valley, which is what a pair
    // actually manages once they have spent cycles walking. Pinning them at
    // a perfect ninety degrees mid valley made every fix nearly exact and
    // hid the entire question this suite exists to ask.
    $ax = 3 + (int)floor(hash32($seed * 3301) * (N - 6));
    $ay = 3 + (int)floor(hash32($seed * 5501 + 7) * (N - 6));
    $sep = 12 + hash32($seed * 7717 + 13) * 12;
    $dir = hash32($seed * 9901 + 29) * 360;
    $A = [$ax, $ay];
    [$bx, $by] = stepAlong($ax, $ay, $dir, $sep);
    $B = [max(1, min(N - 2, $bx)), max(1, min(N - 2, $by))];
    $stations = [cellIndex($A[0], $A[1]), cellIndex($B[0], $B[1])];
    $at = bearingStart($terrain, $profile, $seed, 0);
    $den = $at;

    $cells = []; $cycles = []; $truthAt = $at; $k = $seed * 977 + crc32($profile);
    for ($c = 0; $c < NIGHT; $c++) {
        if ($c === TARGET_CYCLE) $truthAt = $at;
        if (in_array($c, FIX_CYCLES, true)) {
            $xy = cellXY($at);
            $da = bearingBetween($A, $xy) + gauss($k++) * $sigma;
            $db = bearingBetween($B, $xy) + gauss($k++) * $sigma;
            $fix = crossFix($A, $da, $B, $db);
            if ($fix !== null) { $cells[] = $fix; $cycles[] = $c; }
        }
        $at = bearingStep($terrain, $profile, $at, $den, $c, $seed, 'F2', $stations);
    }
    if (count($cells) < 3) return null;        // the night produced no track
    return classifyTrack($terrain, $cells, $cycles)
         + ['cells' => $cells, 'cycles' => $cycles, 'truthAt' => $truthAt];
}

// What a person would actually do with three crosses on a plate: no seed,
// no model, no privileged anything, just a guessed shape and a ruler.
//
// What the shape is worth, once you know it: how much of her recent speed
// she keeps, and how much of her recent TURN she keeps. Measured against
// the oracle rather than reasoned about, because the obvious rules were
// wrong. "A den animal is near the middle of her own track" sounds right
// and is not: she orbits at three and a half cells, so the centre of the
// circle is the one place she reliably is not. What her shape actually
// tells you is that she will keep turning.
const CARRY = [
    'ridge'  => ['speed' => 0.90, 'curl' => 0.35],
    'den'    => ['speed' => 0.95, 'curl' => 1.00],
    'water'  => ['speed' => 0.55, 'curl' => 0.30],
    'flight' => ['speed' => 1.00, 'curl' => 0.00],
];

function predictCell(array $cells, array $cycles, ?string $profile, int $targetCycle): int {
    $n = count($cells);
    [$bx, $by] = cellXY($cells[$n - 1]);
    $ahead = $targetCycle - $cycles[$n - 1];

    if ($profile === null) {
        // the naive baseline: one straight line through the whole track
        [$ax, $ay] = cellXY($cells[0]);
        $span = max(1, $cycles[$n - 1] - $cycles[0]);
        $px = $bx + ($bx - $ax) / $span * $ahead;
        $py = $by + ($by - $ay) / $span * $ahead;
        return cellIndex((int)round(max(0, min(N - 1, $px))), (int)round(max(0, min(N - 1, $py))));
    }

    $c = CARRY[$profile];
    [$mx, $my] = cellXY($cells[$n - 2]);
    $leg = max(1, $cycles[$n - 1] - $cycles[$n - 2]);
    $heading = bearingBetween([$mx, $my], [$bx, $by]);
    $speed = sqrt(pow($bx - $mx, 2) + pow($by - $my, 2)) / $leg;

    // how hard she was turning over the last two legs, carried forward
    $turn = 0.0;
    if ($n >= 3) {
        [$ox, $oy] = cellXY($cells[$n - 3]);
        $prev = bearingBetween([$ox, $oy], [$mx, $my]);
        $turn = angleDelta($heading, $prev) / max(1, $cycles[$n - 1] - $cycles[$n - 3]);
    }
    $go = $heading + $turn * $c['curl'] * $ahead;
    [$px, $py] = stepAlong($bx, $by, $go, $speed * $c['speed'] * $ahead);
    return cellIndex(max(0, min(N - 1, $px)), max(0, min(N - 1, $py)));
}

/** One night, played the way the game asks: read the track, guess the
    shape, call the intercept, and see how far off it landed. */
function interceptError(int $seed, string $profile, float $sigma, bool $useProfile): ?float {
    $r = readNight($seed, $profile, $sigma);
    if ($r === null) return null;
    $guess = $useProfile ? $r['profile'] : null;   // null is plain extrapolation
    $call = predictCell($r['cells'], $r['cycles'], $guess, TARGET_CYCLE);
    return cellMetres($call, $r['truthAt']);
}

function accuracy(float $sigma): array {
    $hit = 0; $n = 0; $confusion = [];
    for ($seed = 1; $seed <= TRIALS; $seed++) {
        foreach (PROFILES as $profile) {
            $r = readNight($seed, $profile, $sigma);
            if ($r === null) continue;
            $n++;
            if ($r['profile'] === $profile) $hit++;
            $confusion[$profile][$r['profile']] = ($confusion[$profile][$r['profile']] ?? 0) + 1;
        }
    }
    return ['acc' => $n ? $hit / $n : 0.0, 'n' => $n, 'confusion' => $confusion];
}

echo "\n1. THE SHAPES ARE ACTUALLY DIFFERENT\n";
// Before asking whether a noisy track is readable, the underlying shapes
// have to be distinguishable at all. A perfect fix is the ceiling.
$perfect = accuracy(0.0);
// A deliberately plain classifier, so this is a LOWER bound on the signal
// present rather than a claim about how well it can be extracted.
check('a perfect track names its profile far more often than chance',
      $perfect['acc'] > 0.55, sprintf('%.1f%% against 25%% chance, of %d', $perfect['acc'] * 100, $perfect['n']));
foreach (PROFILES as $p) {
    $row = $perfect['confusion'][$p] ?? [];
    $tot = array_sum($row);
    check("  $p is not swallowed by another shape",
          $tot > 0 && ($row[$p] ?? 0) / $tot > 0.45,
          sprintf('%.0f%% correct, confused with %s', $tot ? ($row[$p] ?? 0) / $tot * 100 : 0,
                  implode(' ', array_map(fn($k, $v) => "$k:$v", array_keys($row), $row))));
}

echo "\n2. THE INTERCEPT IS WON BY SKILL, NOT BY LUCK\n";
// The real question, in the game's own units. Naming the profile is only a
// proxy; what a pair actually does is call a cell and a cycle and walk
// there. So measure the thing they are graded on: how far the call landed
// from the animal, in metres, and how often that is close enough to touch.
function interceptStats(float $sigma, bool $useProfile): array {
    $errs = [];
    for ($seed = 1; $seed <= TRIALS; $seed++) {
        foreach (PROFILES as $profile) {
            $e = interceptError($seed, $profile, $sigma, $useProfile);
            if ($e !== null) $errs[] = $e;
        }
    }
    sort($errs);
    $hits = 0;
    foreach ($errs as $e) if ($e <= INTERCEPT_M) $hits++;
    return ['median' => $errs[(int)(count($errs) / 2)], 'hit' => $hits / count($errs), 'n' => count($errs)];
}
$tight  = interceptStats(SIGMA_BRACKET, true);
$sloppy = interceptStats(SIGMA_PEAK, true);
$blind  = interceptStats(SIGMA_BRACKET, false);
printf("      half power  median %4.0f m  contact %.0f%%\n", $tight['median'], $tight['hit'] * 100);
printf("      naive peak  median %4.0f m  contact %.0f%%\n", $sloppy['median'], $sloppy['hit'] * 100);
printf("      no shape    median %4.0f m  contact %.0f%%\n", $blind['median'], $blind['hit'] * 100);

check('THE LOAD BEARING ONE: bracketing well lands more intercepts',
      $tight['hit'] > $sloppy['hit'] + 0.06,
      sprintf('%.0f%% vs %.0f%%', $tight['hit'] * 100, $sloppy['hit'] * 100));
check('and lands them closer',
      $tight['median'] < $sloppy['median'] - 40,
      sprintf('%.0f m vs %.0f m', $tight['median'], $sloppy['median']));
check('THE OTHER ONE: reading the shape beats extrapolating blindly',
      $tight['hit'] > $blind['hit'] + 0.05,
      sprintf('%.0f%% vs %.0f%%', $tight['hit'] * 100, $blind['hit'] * 100));
check('a well played intercept is winnable but not a formality',
      $tight['hit'] > 0.35 && $tight['hit'] < 0.85, sprintf('%.0f%%', $tight['hit'] * 100));

echo "\n3. AN ANIMAL STAYS IN THE GAME\n";
// A profile that walks off the plate cannot be intercepted, and a night
// that cannot be won is not a night.
$escaped = 0; $stuck = 0;
for ($seed = 1; $seed <= 120; $seed++) {
    $terrain = generateTerrain($seed);
    foreach (PROFILES as $profile) {
        $at = bearingStart($terrain, $profile, $seed, 0); $den = $at; $moved = 0;
        for ($c = 0; $c < NIGHT; $c++) {
            $next = bearingStep($terrain, $profile, $at, $den, $c, $seed, 'F2', [0, N * N - 1]);
            [$x, $y] = cellXY($next);
            if ($x < INNER || $y < INNER || $x > N - 1 - INNER || $y > N - 1 - INNER) $escaped++;
            if ($next !== $at) $moved++;
            $at = $next;
        }
        if ($moved === 0) $stuck++;
    }
}
check('nothing ever leaves the plate', $escaped === 0, "$escaped steps out of bounds");
check('nothing sits perfectly still all night', $stuck === 0, "$stuck frozen collars");

echo "\n4. THE VALLEY HAS RIDGES WORTH HAVING\n";
// The bounce mechanic needs real relief. A generator that drifts toward
// gentle hills would quietly delete a third of the game.
$blocked = 0; $looks = 0; $relief = [];
for ($seed = 1; $seed <= 120; $seed++) {
    $terrain = generateTerrain($seed);
    $lo = 9; $hi = 0;
    for ($i = 0; $i < N * N; $i++) { $e = (int)$terrain[$i]; $lo = min($lo, $e); $hi = max($hi, $e); }
    $relief[] = $hi - $lo;
    for ($k = 0; $k < 12; $k++) {
        $a = [(int)floor(hash32($seed * 31 + $k) * N), (int)floor(hash32($seed * 71 + $k) * N)];
        $b = [(int)floor(hash32($seed * 131 + $k) * N), (int)floor(hash32($seed * 197 + $k) * N)];
        $looks++;
        if (!lineOfSight($terrain, $a, $b)['clear']) $blocked++;
    }
}
$rate = $blocked / $looks;
$meanRelief = array_sum($relief) / count($relief);
printf("      %.0f%% of sight lines blocked, mean relief %.1f\n", $rate * 100, $meanRelief);
check('a ridge blocks some sight lines but not most', $rate > 0.15 && $rate < 0.75,
      sprintf('%.0f%%', $rate * 100));
check('the valley has real relief in it', $meanRelief >= 6, sprintf('%.1f', $meanRelief));

echo "\n";
echo $failed === 0
    ? "PASS  $passed checks\n"
    : "FAIL  $failed of " . ($passed + $failed) . " checks\n";
exit($failed === 0 ? 0 : 1);
