// DOM-free data and timing logic for the classical massage routine reference,
// unit-tested by tests/masaza-logic.test.mjs (node --test tests/). The page's
// script.js imports this as an ES module. All content is Slovenian, distilled
// from the VITAL course script; times follow the course's 60-minute layout
// (start with the face, end with the feet, 30 min per body side).

export const ROUTINE = [
    {
        id: 'obraz', title: 'Obraz', side: 'front', minutes: 5,
        techniques: ['gladenje', 'gnetenje', 'vtiranje'],
        cues: ['Samo nežni, počasni prijemi: iz sredine navzven, proti sencam', 'Krema ali le tri kapljice olja; brez močnih tehnik'],
    },
    {
        id: 'prsni-kos-trebuh', title: 'Prsni koš in trebuh', side: 'front', minutes: 5,
        techniques: ['gladenje', 'gnetenje', 'tresenje'],
        cues: ['Trebuh: globoki krožni gibi v smeri urinega kazalca', 'Trebuh masiramo vsaj 2 uri po obroku; prsnice ne masiramo'],
    },
    {
        id: 'leva-roka', title: 'Leva roka', side: 'front', minutes: 5,
        techniques: ['gladenje', 'gnetenje', 'vtiranje', 'tresenje'],
        cues: ['Vključno z dlanjo in prsti: gnetenje prstov, vtiranje zapestja', 'Centripetalno, proti srcu; komolca ne gnetemo'],
    },
    {
        id: 'desna-roka', title: 'Desna roka', side: 'front', minutes: 5,
        techniques: ['gladenje', 'gnetenje', 'vtiranje', 'tresenje'],
        cues: ['Enako kot leva: dlan, prsti, podlaket, nadlaket', 'Za tresenje primemo ud v zapestju, z rahlim nategom'],
    },
    {
        id: 'leva-noga-spredaj', title: 'Leva noga spredaj', side: 'front', minutes: 5,
        techniques: ['gladenje', 'gnetenje', 'udarjanje', 'tresenje'],
        cues: ['Velike mišične skupine prenesejo večji pritisk', 'Pogačice ne masiramo; koleno podložimo'],
    },
    {
        id: 'desna-noga-spredaj', title: 'Desna noga spredaj', side: 'front', minutes: 5,
        techniques: ['gladenje', 'gnetenje', 'udarjanje', 'tresenje'],
        cues: ['Enako kot leva: od gležnja proti stegnu', 'Po zadnjem gladenju nogo pokrijemo'],
    },
    {
        id: 'hrbet', title: 'Hrbet', side: 'back', minutes: 15,
        techniques: ['gladenje', 'gnetenje', 'vtiranje', 'udarjanje', 'tresenje'],
        cues: ['Osrednji del masaže: vseh pet tehnik, od križa proti vratu', 'Udarjanje nikoli po hrbtenici, ledvenem delu in lopatičnem kljunu'],
    },
    {
        id: 'leva-noga-zadaj', title: 'Leva noga zadaj', side: 'back', minutes: 5,
        techniques: ['gladenje', 'gnetenje', 'udarjanje', 'tresenje'],
        cues: ['Meča nežneje, stegno krepkeje; ahilova kita s palci', 'Brez udarjanja v podkolenskem pregibu'],
    },
    {
        id: 'desna-noga-zadaj', title: 'Desna noga zadaj', side: 'back', minutes: 5,
        techniques: ['gladenje', 'gnetenje', 'udarjanje', 'tresenje'],
        cues: ['Enako kot leva: gladenje, gnetenje, proti srcu', 'Gib naj teče čez celo dolžino noge, gibov ne krajšamo'],
    },
    {
        id: 'stopala', title: 'Stopala', side: 'back', minutes: 5,
        techniques: ['gladenje', 'gnetenje', 'vtiranje', 'udarjanje'],
        cues: ['Malo olja in čvrst prijem, da ne žgečka; členki po podplatu', 'Zadnja postaja: po potrebi skrajšaj, zaključi z mirnim gladenjem'],
    },
];

export const TEHNIKE = [
    {
        id: 'gladenje', name: 'Gladenje', alias: 'efleraža',
        summary: 'Ritmično, tekoče gladenje: z njim masažo začnemo, povezujemo tehnike in končamo.',
        cues: [
            'Površinsko: uvodni stik, pritisk kot božanje, okoli 12 gladenj na minuto',
            'Globoko: šele ko mišični tonus popusti in je stranka sproščena',
            'Centripetalno: od distalnega prirastišča proti proksimalnemu, v smeri venskega obtoka',
            'Nazaj se vračamo z mehkim površinskim gladenjem',
        ],
    },
    {
        id: 'gnetenje', name: 'Gnetenje', alias: 'petrisaža',
        summary: 'Raztezanje in sproščanje trebušastih mišic; gibanje rok daje videz valovanja.',
        cues: [
            'Natančno, počasno in ritmično, z obema rokama izmenično',
            'Pritisk centripetalno, premiki so lahko v obe smeri',
            'Pazimo, da ne ščipamo',
        ],
    },
    {
        id: 'vtiranje', name: 'Vtiranje', alias: 'frikcija',
        summary: 'Krožni gibi, usmerjeni v globino: zrahljajo zlepljene strukture in zmehčajo brazgotine.',
        cues: [
            '3 do 10 krožnih gibov na enem mestu',
            'Pritisk popustimo in z gladenjem zdrsimo na novo površino',
            'Ne sme povzročati neprijetne bolečine',
        ],
    },
    {
        id: 'udarjanje', name: 'Udarjanje', alias: 'tapotman',
        summary: 'Kratki, prožni izmenični udarci obeh rok; zelo poživljajoči, za mišičaste predele.',
        cues: [
            'Sekljanje, vakuum s konkavno dlanjo, ščipanje ali pesti',
            'Če je le mogoče, udarjamo centripetalno, v smeri mišičnih vlaken',
            'Nikoli na kosteh, ledvenem delu, spodnjem delu trebuha in notranjih pregibih',
        ],
    },
    {
        id: 'tresenje', name: 'Tresenje', alias: 'vibracija',
        summary: 'S tresenjem sprostimo obrambni mišični krč in izboljšamo prekrvavitev.',
        cues: [
            'Ročno 5 do 10 tresljajev na sekundo',
            'Izvajamo pred udarjanjem in po njem',
            'Mišico, skupino ali cel ud: primemo v zapestju ali gležnju, z rahlim nategom',
        ],
    },
];

export const VRSTNI_RED = [
    { title: 'Namestitev in pokritje', note: 'Udoben položaj, podložimo glavo in kolena; pokrijemo z dvema brisačama.' },
    { title: 'Vizualni pregled', note: 'Odkrijemo predel, ki ga bomo masirali; pregledamo kožo, boleč predel pretipamo.' },
    { title: 'Prvi stik', note: 'Nežno, kot padalo; nekaj sekund mirno, da začutimo temperaturo, utrip in dihanje.' },
    { title: 'Nanos olja', note: 'Olje nalijemo v konkavni del dlani in ga segrejemo; nikoli neposredno na kožo.' },
    { title: 'Površinsko gladenje', note: 'Vsak prijem 3 do 10x, gibov ne krajšamo; počasen, zaspan, enakomeren ritem.' },
    { title: 'Globoko gladenje', note: 'Centripetalno, močneje proti srcu; nazaj se vračamo s površinskim gladenjem.' },
    { title: 'Druge tehnike', note: 'Gnetenje, vtiranje, udarjanje, tresenje po izbiri; prehodi naj bodo tekoči.' },
    { title: 'Zaključno gladenje', note: 'Umirimo ritem, ustavimo se za nekaj sekund in stranko spet pokrijemo.' },
];

export const NE_MASIRAMO = {
    zones: [
        'Predel vratu spredaj',
        'Materina znamenja nad nivojem kože',
        'Kjer se kosti dotikajo kože: ključnica, prsnica, križnica, vretenca, pogačica, komolec, lopatični kljun',
        'Kjer pridejo na površje ožilje, živci in bezgavke: pazduha, dimlje, upogibni del kolena in komolca',
        'Trebuh manj kot 2 uri po obroku',
        'Prsi in predel spolnih organov',
        'Predeli, ki jih stranka ne dovoli masirati',
    ],
    motto: 'ČE DVOMIŠ, NE MASIRAJ',
    latin: 'Primum non nocere',
};

// Expands the routine into contiguous second offsets from 0.
export function buildSchedule(routine = ROUTINE) {
    let cursor = 0;
    return routine.map(segment => {
        const duration = segment.minutes * 60;
        const entry = { ...segment, start: cursor, end: cursor + duration, duration };
        cursor = entry.end;
        return entry;
    });
}

// Index of the first back-side segment (the "stranka se obrne" moment), -1 if none.
export function flipIndex(schedule) {
    return schedule.findIndex(segment => segment.side === 'back');
}

// Where in the schedule a given elapsed second lands. Boundaries are
// start-inclusive, end-exclusive, so elapsed 300 already belongs to segment 1.
export function segmentAt(schedule, elapsed) {
    const at = Math.max(0, elapsed);
    for (let index = 0; index < schedule.length; index++) {
        const segment = schedule[index];
        if (at < segment.end) {
            return {
                done: false,
                index,
                segment,
                segmentElapsed: at - segment.start,
                segmentRemaining: segment.end - at,
            };
        }
    }
    return { done: true, index: schedule.length, segment: null, segmentElapsed: 0, segmentRemaining: 0 };
}

// Session reducers: immutable, wall-clock driven (the caller passes epoch ms),
// so elapsed time is a pure delta and never accumulates interval drift.
// `banked` holds seconds already earned before the current running stretch.
export function startSession(now) {
    return { anchor: now, banked: 0, paused: false };
}

export function elapsedSeconds(session, now) {
    return session.paused ? session.banked : session.banked + (now - session.anchor) / 1000;
}

export function pauseSession(session, now) {
    if (session.paused) return session;
    return { anchor: null, banked: elapsedSeconds(session, now), paused: true };
}

export function resumeSession(session, now) {
    if (!session.paused) return session;
    return { anchor: now, banked: session.banked, paused: false };
}

// Jumps elapsed time to the end of the segment currently running (feet often
// get squeezed, so the masseur can hand time forward). No-op once done.
export function skipToNext(session, schedule, now) {
    const at = segmentAt(schedule, elapsedSeconds(session, now));
    if (at.done) return session;
    return { anchor: session.paused ? null : now, banked: at.segment.end, paused: session.paused };
}

export function formatTime(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const min = Math.floor(total / 60);
    const sec = total % 60;
    return `${min}:${String(sec).padStart(2, '0')}`;
}

export const PRIPRAVA = [
    'Prostor: 22 do 24 °C, okoli 55 % vlažnosti, mirna razsvetljava',
    'Roke: umite, razkužene in tople; kratki, nelakirani nohti',
    'Brez nakita in zapestne ure',
    'Uvodni pogovor: kontraindikacije, bolečine, zdravila, cilj masaže',
    'Čiste rjuhe, brisače in svitki za podlaganje',
    'Masažno sredstvo ogreto vsaj na sobno temperaturo',
];
