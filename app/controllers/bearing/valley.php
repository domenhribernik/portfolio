<?php
declare(strict_types=1);
// BEARING / the valley.
//
// Every pure fact about the ground and what an antenna hears standing on
// it. No database, no session, no output: requiring this file does
// nothing observable, which is what lets tests/bearing-sim.test.php run
// the physics thousands of times without a server.
//
// The controller owns the rooms. This file owns the world.

const N = 32;                    // valley is N x N cells
const CELL_M = 100;              // one cell is a hundred metres

// A night's weather, drawn from the seed. It does not carry the game: it
// varies where you can afford to stand, which varies the gather-or-act
// maths. `bounce` is how loudly a reflection comes back off a ridge, so a
// storm does not merely add hiss, it makes a wrong bearing more convincing.
const WEATHERS = ['clear', 'haze', 'storm'];
const WEATHER = [
    'clear' => ['reach' => 1.00, 'noise' => 1.00, 'bounce' => 0.55],
    'haze'  => ['reach' => 0.88, 'noise' => 1.40, 'bounce' => 0.62],
    'storm' => ['reach' => 0.74, 'noise' => 1.85, 'bounce' => 0.70],
];
function weatherOf(string $w): array { return WEATHER[$w] ?? WEATHER['clear']; }

/* ---- deterministic noise, mirrored in views/bearing/logic.js ------------
   Same integer hash on both sides so a trace generated here and a trace
   generated in the practice trainer behave identically. */
function hash32(int $x): float {
    $x = ($x ^ 61) ^ (($x >> 16) & 0xFFFF);
    $x = ($x + ($x << 3)) & 0xFFFFFFFF;
    $x = $x ^ (($x >> 4) & 0x0FFFFFFF);
    $x = ($x * 0x27d4eb2d) & 0xFFFFFFFF;
    $x = $x ^ (($x >> 15) & 0x1FFFF);
    return ($x & 0xFFFFFFFF) / 4294967296.0;
}
function valueNoise(float $pos, int $period, int $salt): float {
    $s = $pos / $period; $i = (int)floor($s); $f = $s - $i;
    $h0 = hash32($i * 7919 + $salt); $h1 = hash32(($i + 1) * 7919 + $salt);
    $t = $f * $f * (3 - 2 * $f);
    return $h0 + ($h1 - $h0) * $t;
}

/* ------------------------------------------------------------- the valley */

/** Row-major elevation, one digit per cell. Ridges are what make a bearing
    lie AND what a ridge-running animal follows, so the generator has to
    produce real ones rather than gentle hills. */
function generateTerrain(int $seed): string {
    $out = '';
    for ($y = 0; $y < N; $y++) {
        for ($x = 0; $x < N; $x++) {
            $v  = valueNoise($x + $y * 0.37, 9, $seed) * 0.55;
            $v += valueNoise($y - $x * 0.29, 7, $seed + 991) * 0.45;
            $v += valueNoise($x * 0.6 + $y * 0.6, 3, $seed + 5077) * 0.22;
            // a valley floor: pull the middle band down so there is somewhere to walk
            $v -= 0.30 * exp(-pow(($y - N / 2) / (N * 0.28), 2));
            $d = (int)max(0, min(9, round($v * 11)));
            $out .= (string)$d;
        }
    }
    return $out;
}
function elevAt(string $terrain, int $x, int $y): int {
    if ($x < 0 || $y < 0 || $x >= N || $y >= N) return 0;
    return (int)$terrain[$y * N + $x];
}
function cellIndex(int $x, int $y): int { return $y * N + $x; }
function cellXY(int $idx): array { return [$idx % N, intdiv($idx, N)]; }
function chebyshev(int $a, int $b): int {
    [$ax, $ay] = cellXY($a); [$bx, $by] = cellXY($b);
    return max(abs($ax - $bx), abs($ay - $by));
}
function cellMetres(int $a, int $b): float {
    [$ax, $ay] = cellXY($a); [$bx, $by] = cellXY($b);
    return sqrt(pow($ax - $bx, 2) + pow($ay - $by, 2)) * CELL_M;
}

/** Does the ground get in the way? Walk the line and compare each cell's
    height against the straight path between the two ends. */
function lineOfSight(string $terrain, array $from, array $to): array {
    [$x0, $y0] = $from; [$x1, $y1] = $to;
    $steps = (int)max(1, ceil(max(abs($x1 - $x0), abs($y1 - $y0))));
    $h0 = elevAt($terrain, $x0, $y0) + 2;   // an antenna is held up
    $h1 = elevAt($terrain, $x1, $y1) + 1;   // a collar is on an animal
    $worst = null; $worstBy = 0.0;
    for ($i = 1; $i < $steps; $i++) {
        $f = $i / $steps;
        $x = (int)round($x0 + ($x1 - $x0) * $f);
        $y = (int)round($y0 + ($y1 - $y0) * $f);
        $line = $h0 + ($h1 - $h0) * $f;
        $ground = elevAt($terrain, $x, $y);
        if ($ground > $line && ($ground - $line) > $worstBy) {
            $worstBy = $ground - $line; $worst = [$x, $y];
        }
    }
    return ['clear' => $worst === null, 'ridge' => $worst, 'by' => $worstBy];
}

function bearingBetween(array $from, array $to): float {
    $deg = atan2($to[0] - $from[0], -($to[1] - $from[1])) * 180 / M_PI;
    return fmod($deg + 360, 360);
}
function angleDelta(float $a, float $b): float {
    return fmod(fmod($a - $b, 360) + 540, 360) - 180;
}

/** The 360-sample trace a station hears when it sweeps a collar.
    When a ridge blocks the path the signal does not vanish: it arrives off
    the reflecting slope instead, so the trace shows a confident hump in
    the wrong direction. That is the whole reason two opinions beat one. */
function sweepTrace(string $terrain, array $station, array $animal, int $seed,
                    int $cycle, string $collar, string $weather = 'clear'): array {
    $w = weatherOf($weather);
    $los = lineOfSight($terrain, $station, $animal);
    $source = $los['clear'] ? $animal : $los['ridge'];
    $true = bearingBetween($station, $source);
    $dist = sqrt(pow($animal[0] - $station[0], 2) + pow($animal[1] - $station[1], 2));
    $reach = (1 - min(0.5, $dist / 36)) * $w['reach'];
    if (!$los['clear']) $reach *= $w['bounce'];   // a bounce is quieter and broader
    $lobe = $los['clear'] ? 5 : 3;                // and its hump is fatter

    $salt = $seed * 31 + $cycle * 7 + crc32($collar);
    $out = [];
    for ($a = 0; $a < 360; $a++) {
        $d = abs(angleDelta((float)$a, $true));
        $main = pow(max(0, cos($d * M_PI / 180)), $lobe);
        $back = 0.13 * pow(max(0, cos((180 - $d) * M_PI / 180)), 8);
        $noise = (valueNoise((float)$a, 9, $salt) * 0.62 + valueNoise((float)$a, 3, $salt + 17) * 0.38) - 0.5;
        $v = ($main + $back) * $reach + 0.06
           + $noise * (0.09 + 0.16 * (1 - $reach)) * $w['noise'];
        $out[] = (int)round(max(0, min(1, $v)) * 1000);
    }
    return ['trace' => $out, 'bounced' => !$los['clear']];
}
