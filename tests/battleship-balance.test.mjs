// The suite that holds Battleship's design claims to account.
//
// The variant exists to answer two complaints about the classic game: it is
// mostly luck, and whoever finds a hull first runs away with it. The salvage
// economy, the five tools and the unlock ladder are the answer. None of that
// is worth anything as prose, so it is simulated here.
//
// Every number below is DETERMINISTIC: fixed seeds, no wall clock, no
// Math.random. A failure is exactly reproducible and means a constant moved,
// not that the suite got unlucky. The bands are regression guards with a few
// points of slack, not claims to three decimal places.
//
// One thing this suite deliberately does NOT claim. Both simulated players are
// the same near optimal density hunter, so an early lead between them is
// mostly a fact about where the fleets happened to be laid, and no rule set
// shows a snowball at all under that microscope. The snowball the design is
// aimed at is a human one: a person who has found a hull has momentum and a
// person who has not is still guessing. So the comeback claim is measured the
// only honest way available, by handicapping a fleet outright and asking
// whether the toolbox lets it fight.
//
// Run: node --test tests/     (Windows: node --test "tests/**/*.test.mjs")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POLICIES, playOut } from '../views/battleship/bot.js';

const RING = ['sonar', 'barrage', 'depthCharge', 'reposition', 'decoy'];

/** Win rate of `a` over a seeded series against `b`, sides swapped each game. */
function series(a, b, tag, games) {
    let wins = 0;
    for (let g = 0; g < games; g++) {
        // Alternate who opens. The first shot is worth something, and no
        // policy should be able to win its series by always moving first.
        const aIsSeatOne = g % 2 === 0;
        const policies = aIsSeatOne ? [a, b] : [b, a];
        const { outcome } = playOut({ seed: g * 7919 + tag, policies, starter: 1 });
        const winner = outcome === 'p1' ? 1 : 2;
        if ((aIsSeatOne && winner === 1) || (!aIsSeatOne && winner === 2)) wins++;
    }
    return wins / games;
}

const pct = (r) => `${(r * 100).toFixed(0)}%`;

test('no single tool is a must buy, and none is a trap', () => {
    // The sharpest form of "there must be no one winning strategy": put each
    // tool on its own against a player who only ever fires. A tool that runs
    // away with this is the opening everyone would solve; a tool that loses it
    // is one nobody should ever buy, which is clutter with a keyboard shortcut.
    const table = RING.map((name, i) => [name, series(POLICIES[name], POLICIES.none, i * 131 + 5, 120)]);
    const report = table.map(([n, r]) => `${n} ${pct(r)}`).join(', ');
    for (const [name, rate] of table) {
        assert.ok(rate >= 0.33 && rate <= 0.72, `${name} is off the band against plain fire (${report})`);
    }
});

test('no single tool runs away with the field', () => {
    // Weaker evidence than the test above, and the band is wide to match: a
    // tool that exists to aim another one has nothing to aim when it is alone
    // in the ring, so the depth charge is expected to sit at the top of this
    // table. This is watching for a runaway, not for parity.
    const scores = Object.fromEntries(RING.map((n) => [n, { played: 0, won: 0 }]));
    for (let i = 0; i < RING.length; i++) {
        for (let j = i + 1; j < RING.length; j++) {
            const rate = series(POLICIES[RING[i]], POLICIES[RING[j]], i * 10 + j, 60);
            scores[RING[i]].won += rate * 60; scores[RING[i]].played += 60;
            scores[RING[j]].won += (1 - rate) * 60; scores[RING[j]].played += 60;
        }
    }
    const table = RING.map((n) => [n, scores[n].won / scores[n].played]);
    const report = table.map(([n, r]) => `${n} ${pct(r)}`).join(', ');
    for (const [name, rate] of table) {
        assert.ok(rate >= 0.25 && rate <= 0.78, `${name} runs away with the ring (${report})`);
    }
});

test('the toolbox beats buying nothing, without making the gunner obsolete', () => {
    // Both halves matter. If spending lost, the economy would be decoration
    // and every turn would answer itself; if it won by a landslide, the
    // decision would be gone the other way.
    const rate = series(POLICIES.full, POLICIES.none, 991, 120);
    assert.ok(rate >= 0.5 && rate <= 0.72, `the full toolbox wins ${pct(rate)} against plain fire`);
});

// ------------------------------------------------------------------
//  The comeback claim
// ------------------------------------------------------------------

/** Win rate of a fleet that starts two hulls down, under a given toolbox. */
function handicapped(policies, games = 300) {
    let wins = 0;
    for (let g = 0; g < games; g++) {
        const { outcome } = playOut({ seed: g * 7919 + 17, policies, starter: 1, handicap: [0, 2] });
        if (outcome === 'p2') wins++;
    }
    return wins / games;
}

test('a fleet that is already losing fights better because the toolbox exists', () => {
    // The clean version of the comeback measurement. Same handicap in both
    // arms, so this is not conditioning on an event the two rule sets reach at
    // different rates, which is what made every earlier attempt at this test
    // meaningless. The only thing that changes is whether the tools exist.
    const withTools = handicapped([POLICIES.full, POLICIES.full]);
    const without = handicapped([POLICIES.none, POLICIES.none]);
    assert.ok(withTools > without * 1.2,
        `two hulls down wins ${pct(withTools)} with the toolbox against ${pct(without)} without it`);
});

test('being two hulls down is still a bad place to be', () => {
    // The other half of the same claim, and the one that keeps the game
    // honest. A catch up mechanic that erased a two hull deficit would make
    // the first half of every match meaningless.
    const withTools = handicapped([POLICIES.full, POLICIES.full]);
    assert.ok(withTools <= 0.3, `two hulls down still wins ${pct(withTools)}, which is not a deficit`);
});
