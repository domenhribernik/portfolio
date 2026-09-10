// The tower's method library. Every entry is a real method and its real place
// notation; nothing here is invented. tests/peal-methods.test.mjs rings each one
// from rounds and refuses the file if a course does not come home true at the
// stated length, so a typo in a notation string fails the build rather than
// quietly ringing something that is not the method it claims to be.
//
// `notation` is the only load-bearing field. `leads` and `changes` are written
// down so the test has something to disagree with.

export const METHODS = [
    {
        key: 'plain-hunt-5',
        name: 'Plain Hunt Doubles',
        stage: 5,
        notation: '5.1',
        class: 'Hunt',
        leads: 5,
        changes: 10,
        note: 'Every bell walks out to the back and straight home again, and nothing else happens. It is the first thing anyone rings and the skeleton inside everything below.'
    },
    {
        key: 'plain-hunt-6',
        name: 'Plain Hunt Minor',
        stage: 6,
        notation: 'x16',
        class: 'Hunt',
        leads: 6,
        changes: 12,
        note: 'The same walk on six. Twelve rows and you are back where you started, which is why it can never be rung for a peal.'
    },
    {
        key: 'plain-hunt-8',
        name: 'Plain Hunt Major',
        stage: 8,
        notation: 'x18',
        class: 'Hunt',
        leads: 8,
        changes: 16,
        note: 'On eight the walk is long enough to feel like a shape rather than a scale.'
    },
    {
        key: 'plain-bob-5',
        name: 'Plain Bob Doubles',
        stage: 5,
        notation: '&5.1.5.1.5,125',
        class: 'Plain',
        leads: 4,
        changes: 40,
        note: 'Plain hunt with one bell held back at the end of every lead, which is enough to stop the whole thing repeating after ten rows. This is the method every ringer learns second.'
    },
    {
        key: 'plain-bob-6',
        name: 'Plain Bob Minor',
        stage: 6,
        notation: '&x16x16x16,12',
        class: 'Plain',
        leads: 5,
        changes: 60,
        note: 'The standard six bell method. Sixty rows, none of them repeated, and the blue line is a shape most ringers can draw from memory.'
    },
    {
        key: 'plain-bob-7',
        name: 'Plain Bob Triples',
        stage: 7,
        notation: '&7.1.7.1.7.1.7,127',
        class: 'Plain',
        leads: 6,
        changes: 84,
        note: 'Seven bells, so the tenor stands at the back throughout and covers. Odd stages always ring with a bell doing nothing but keeping time.'
    },
    {
        key: 'plain-bob-8',
        name: 'Plain Bob Major',
        stage: 8,
        notation: '&x18x18x18x18,12',
        class: 'Plain',
        leads: 7,
        changes: 112,
        note: 'The same idea stretched over eight. A hundred and twelve rows before it closes, and the tenor takes four seconds to swing.'
    },
    {
        key: 'grandsire-5',
        name: 'Grandsire Doubles',
        stage: 5,
        notation: '3,&1.5.1.5.1',
        class: 'Plain',
        leads: 3,
        changes: 30,
        note: 'Older than Plain Bob and built differently: two bells hunt instead of one, so the treble has company all the way out and back.'
    },
    {
        key: 'grandsire-7',
        name: 'Grandsire Triples',
        stage: 7,
        notation: '3,&1.7.1.7.1.7.1',
        class: 'Plain',
        leads: 5,
        changes: 70,
        note: 'The method the sport argued about for two centuries, because getting a true peal of it out of the calling is genuinely hard.'
    },
    {
        key: 'stedman-5',
        name: 'Stedman Doubles',
        stage: 5,
        notation: '3.1.5.3.1.3.1.3.5.1.3.1',
        class: 'Principle',
        leads: 5,
        changes: 60,
        note: 'No hunt bell at all. Every bell does exactly the same work, three of them grinding away at the front while the others hunt behind, and the pattern shifts every six rows.'
    },
    {
        key: 'kent-6',
        name: 'Kent Treble Bob Minor',
        stage: 6,
        notation: '&34x34.16x12x36x12x16,12',
        class: 'Treble Bob',
        leads: 5,
        changes: 120,
        note: 'The treble stops walking straight and starts dodging its way to the back, which doubles the length of a lead and gives every other bell somewhere new to be.'
    },
    {
        key: 'cambridge-6',
        name: 'Cambridge Surprise Minor',
        stage: 6,
        notation: '&x36x14x12x36x14x56,12',
        class: 'Surprise',
        leads: 5,
        changes: 120,
        note: 'The first Surprise method most bands ring, and the one whose line is worth learning properly. Places are made across the treble everywhere, which is what Surprise means.'
    },
    {
        key: 'cambridge-8',
        name: 'Cambridge Surprise Major',
        stage: 8,
        notation: '&x38x14x1258x36x14x58x16x78,12',
        class: 'Surprise',
        leads: 7,
        changes: 224,
        note: 'Cambridge grown onto eight bells. Two hundred and twenty four rows, and the front work is the same shape you learned on six.'
    },
    {
        key: 'bristol-8',
        name: 'Bristol Surprise Major',
        stage: 8,
        notation: '&x58x14.58x58.36.14x14.58x14x18,18',
        class: 'Surprise',
        leads: 7,
        changes: 224,
        note: 'The one ringers show off about. The line refuses to settle into anything you can predict, and it is regarded as the finest Major method there is.'
    },
    {
        key: 'double-norwich-8',
        name: 'Double Norwich Court Bob Major',
        stage: 8,
        notation: '&x14x36x58x18,18',
        class: 'Court',
        leads: 7,
        changes: 112,
        note: 'Double in the technical sense: turn the blue line upside down and back to front and you get the same line again. Very few methods do that.'
    }
];

// Every method that can be rung on a given number of bells.
export function methodsForStage(stage) {
    return METHODS.filter((m) => m.stage === stage);
}

// The stages the library covers, smallest first.
export function libraryStages() {
    return [...new Set(METHODS.map((m) => m.stage))].sort((a, b) => a - b);
}

export function methodByKey(key) {
    return METHODS.find((m) => m.key === key) || null;
}
