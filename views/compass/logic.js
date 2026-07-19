// DOM-free data and tracking logic for Compass, the private No More Mr. Nice
// Guy practice tracker (views/compass). Unit-tested by
// tests/compass-logic.test.mjs (node --test tests/). The page's script.js
// imports this as an ES module.
//
// Everything here is built on Dr. Robert Glover's "No More Mr. Nice Guy":
// the six daily practices operationalize the book's recovery program, the
// catch patterns name the Nice Guy behaviors it describes, and ACTIVITIES
// paraphrases the book's 46 Breaking Free exercises as a trackable workbook.

// --- The six daily practices ---
// Three face her (she said: "I don't feel loved", "I feel ugly", "he doesn't
// care"), three face me (the book: an integrated man attracts; a needy,
// approval-seeking one repels). A day is "kept" when at least GOAL are done.

export const PRACTICES = [
    {
        key: 'seen',
        label: 'Make her feel seen',
        detail: 'Tell her one specific, true thing you noticed about her today. Not "you\'re pretty", but the exact thing: her laugh on the call, how she handled something, what she wore. Expect nothing back.',
        why: 'She said she feels ugly and unloved. Caring gives what the receiver needs (ch. 4), and what she needs is evidence that you actually look at her. Generic compliments are noise; specific ones are proof.',
    },
    {
        key: 'present',
        label: 'Give undivided presence',
        detail: 'One call or conversation with everything else closed. No game in the background, no scrolling, no half-answers. If you can\'t be present, say when you can and mean it.',
        why: '"He doesn\'t care" almost always decodes to "he isn\'t there". Long distance means presence IS the relationship. Divided attention is the avoider pattern (ch. 7): nice to everything except her.',
    },
    {
        key: 'direct',
        label: 'Be clear and direct',
        detail: 'Say one real feeling or want plainly today: "I miss you", "that hurt", "I want to plan the next visit". No hints, no fishing, no Defend-Explain-Excuse-Rationalize.',
        why: 'Nice Guys are fundamentally dishonest: they hide feelings to keep things smooth (ch. 1, ch. 5). Withheld feelings leak out later as resentment. Directness is what makes her feel safe.',
    },
    {
        key: 'nostrings',
        label: 'Give without a scoreboard',
        detail: 'Whatever you give today (time, words, gifts, listening), give it free. If you catch yourself giving to get something back, name the covert contract to yourself and drop it.',
        why: 'Covert contracts (ch. 4) are the engine of the Nice Guy Syndrome: "I do this so you\'ll do that, and we both pretend the deal doesn\'t exist." She can feel the strings, and strings never read as love.',
    },
    {
        key: 'self',
        label: 'Fill my own tank',
        detail: 'Do one thing today that is only for you: train, see a friend, work on a passion. Not as a reward and not instead of her, but because a man needs a life of his own.',
        why: 'Making her your emotional center is enmeshment (ch. 7); it makes you needy, and needy is not attractive (ch. 4). Taking care of yourself is how you show up with something to give.',
    },
    {
        key: 'lead',
        label: 'Take the lead',
        detail: 'Initiate something today: message first, plan the date call, move the next visit forward. Decide and propose instead of waiting and reacting.',
        why: 'An integrated male is willing to provide and lead (ch. 1, ch. 6). Waiting for her to organize the relationship tells her she carries it alone, which is exactly "he doesn\'t care".',
    },
];

// --- The catch log ---
// The book's not-so-nice behaviors (ch. 1-5), named so a slip can be logged
// the moment it's noticed. Catching one is progress, not failure: awareness
// comes before change, so early weeks SHOULD show more catches, not fewer.

export const PATTERNS = [
    {
        key: 'approval',
        label: 'Approval seeking',
        hint: 'Did or said something mainly so she (or anyone) would think well of me: performed, agreed when I didn\'t, fished for validation.',
    },
    {
        key: 'covert',
        label: 'Covert contract',
        hint: 'Gave to get: kindness, favors or "I love you" sent out with an invisible invoice attached, then kept score.',
    },
    {
        key: 'caretake',
        label: 'Caretaking / fixing',
        hint: 'Jumped in to fix her problem or mood without being asked, instead of listening. Fixing is about my anxiety, not her need.',
    },
    {
        key: 'hide',
        label: 'Hiding / omission',
        hint: 'Shaded the truth, left things out, or hid a mistake so nobody would get upset. "If at first you don\'t succeed, hide the evidence."',
    },
    {
        key: 'deer',
        label: 'DEER response',
        hint: 'She raised something and I Defended, Explained, Excused, Rationalized instead of hearing her out and owning my part.',
    },
    {
        key: 'victim',
        label: 'Victim puke',
        hint: 'Resentment leaked: pouting, jabs, silent treatment, "after all I do for you", withdrawing, a blow-up over something small.',
    },
    {
        key: 'avoid',
        label: 'Conflict avoidance',
        hint: 'Swallowed a "no", didn\'t set a boundary, kept the peace instead of saying what I actually felt or wanted.',
    },
    {
        key: 'settle',
        label: 'Settling / scarcity',
        hint: 'Acted from "there isn\'t enough and I don\'t deserve more": played small, settled for scraps, made excuses instead of asking.',
    },
];

// --- The Breaking Free workbook ---
// The book's 46 Breaking Free activities, paraphrased into one prompt each
// and numbered as in the book, so the whole program is trackable. Status per
// activity (todo / doing / done) plus a journal note live in the database.

export const CHAPTERS = {
    1: 'The Nice Guy Syndrome',
    2: 'The Making of a Nice Guy',
    3: 'Learn to Please Yourself',
    4: 'Make Your Needs a Priority',
    5: 'Reclaim Your Personal Power',
    6: 'Reclaim Your Masculinity',
    7: 'Get the Love You Want',
    8: 'Get the Sex You Want',
    9: 'Get the Life You Want',
};

const A = (num, chapter, title, prompt) => ({ num, chapter, title, prompt });

export const ACTIVITIES = [
    A(1, 1, 'Find safe people',
        'Write down three safe people or groups who could support you in this work (a friend, a therapist, a men\'s group). If nobody comes to mind, list where you could find them, and contact one.'),
    A(2, 1, 'Why hide?',
        'Sit with the question: why would it ever seem rational for a man to hide who he really is and try to become something else? Why do people try to change who they are? Is this you?'),
    A(3, 2, 'Name the messages',
        'Write down the childhood messages that implied it was not OK to be who you were, just as you were. Share them with a safe person and note what you feel. The goal is to name, not to blame.'),
    A(4, 3, 'List your attachments',
        'List the things you attach your worth to in order to get approval (being smart, agreeable, fit, helpful, different from other men...). Ask someone who knows you how they see you seeking approval.'),
    A(5, 3, 'Life without approval',
        'If you did not care what people thought of you, how would you live differently? If you were not chasing women\'s approval, how would your relationships with women change? Write it down.'),
    A(6, 3, 'Where you hide',
        'Write down concrete situations where you hide mistakes or flaws or distract attention from them. How well do you think this hiding actually works on the people who love you?'),
    A(7, 3, 'Loved with flaws',
        'Do you believe people can see your imperfections and still love you? How would you act differently if you knew the people who care about you would never leave, no matter what?'),
    A(8, 3, 'Approval experiment',
        'Pick one approval-seeking behavior. Either stop it completely for a set time, or consciously do it MORE. Tell people what you are doing, observe what you feel, and report to a safe person.'),
    A(9, 3, 'Daily self-care',
        'Build a list of good things to do for yourself (sleep, training, food, music, a massage, time with friends). Put it where you see it and do at least one every day, especially when it feels wrong.'),
    A(10, 3, 'Affirmation cards',
        'Write affirmations that counter the old story ("I am lovable just as I am", "my needs are important", "I can handle it"). Put them where you will see them and actually read them.'),
    A(11, 3, 'Go alone',
        'Plan a weekend, or longer, alone, somewhere nobody knows you. No pleasing anyone, no performing. Keep a journal, watch your urge to distract yourself, and see who you are when nobody is watching.'),
    A(12, 4, 'Needs are allowed',
        'Answer honestly: do you believe it is OK to have needs? Do you believe people WANT to help you meet them? Do you believe the world has enough to go around? Write out where the "no" comes from.'),
    A(13, 4, 'Expose a covert contract',
        'Identify one covert contract with someone close: what do you give, and what do you silently expect back? Tell them about it and ask how it feels to be on the other end of an unspoken deal.'),
    A(14, 4, 'Caretaking experiment',
        'For one week either stop all caretaking (except of dependent children), or consciously caretake MORE. Tell people what you are doing. Watch your anxiety and their reactions.'),
    A(15, 4, 'How I actually hurt people',
        'List the ways your buried resentment leaks onto people you love: jokes with an edge, lateness, "forgetting", criticism, withdrawing, blowing up. Then ask them for honest feedback about it.'),
    A(16, 4, 'Put yourself first',
        'For a full weekend or week, put your own needs first. Tell the people around you. Notice the guilt, do it anyway, and afterwards ask them what it was actually like for them.'),
    A(17, 5, 'Map the survival mechanisms',
        'For each smooth-life strategy (doing it right, playing it safe, anticipating and fixing, never being a problem...), write one childhood example and one from this month. See the pattern as one thing.'),
    A(18, 5, 'Find the gift',
        'Recall one hard thing you fought against that turned out to grow you. What present difficulty might be the same kind of gift? What is it asking you to learn?'),
    A(19, 5, 'Dwell in reality',
        'Pick one area of constant frustration. Are you projecting the reality you WANT onto it instead of seeing what is? Write down what is actually true, and how you would respond to that.'),
    A(20, 5, 'Say feelings as feelings',
        'Practice feeling statements: "I feel angry", not "you make me angry"; what your body feels, not what you think about someone. Start sentences with "I". Use this in one real conversation.'),
    A(21, 5, 'Face one fear',
        'Name one fear that has been steering your life. Decide to walk straight at it, repeating: "I can handle it. No matter what happens, I will handle it." Then do the thing.'),
    A(22, 5, 'Come clean',
        'Choose one place you are out of integrity: a lie, a half-truth, something hidden. Name the fear underneath, tell a safe person, then tell the truth where it belongs and make it right.'),
    A(23, 5, 'Watch your line',
        'For a week, observe every time you back away from your own line: saying yes meaning no, tolerating what should not be tolerated, keeping the peace. Write each one down and share the list.'),
    A(24, 6, 'Different from Dad?',
        'List the ways you have tried to be different from your father or from "other men". How does believing you are different keep you disconnected from men, and from your own masculinity?'),
    A(25, 6, 'Three men',
        'List three men you would like to know better, one concrete activity for each, and a date by which you will reach out. Then actually contact them.'),
    A(26, 6, 'Body debt',
        'Write down three ways you neglect your body, and three specific ways you will start taking care of it (training, food, sleep, cutting the junk). Start this week.'),
    A(27, 6, 'A healthy man',
        'Describe what a healthy, integrated man looks like to you: his traits, how he moves through the world. Who do you know with some of those traits? Use him as a living reference.'),
    A(28, 6, 'See your father accurately',
        'List your father\'s characteristics on the left, their opposites on the right, and mark where YOU actually sit on each line. Take him out of the gutter or off the pedestal: a wounded human, not a caricature.'),
    A(29, 6, 'Pass it on',
        'How can you be a healthy male presence for the boys or young men around you (family, sport, mentoring)? Name three and one thing you could do with each.'),
    A(30, 7, 'Enmesher or avoider?',
        'In this relationship, are you an enmesher (she is your emotional center, you hover for scraps) or an avoider (present for everyone except her)? How would SHE answer? Write both views down.'),
    A(31, 7, 'The familiar pattern',
        'We pick partners who help us re-run childhood patterns. Identify what old, familiar dynamic your relationship lets you replay, and stop blaming her for a system you co-created. Share it with her.'),
    A(32, 7, 'Still Mom\'s man?',
        'Look honestly at the ways you may still be monogamous to your mother or bonded to her needs: over-work, fixing everyone, unavailable partners, secrets. Note what applies and tell a safe person.'),
    A(33, 7, 'Stop managing her happiness',
        'List the ways you try to please your partner and manage her moods. What would you do differently if her happiness were her responsibility and yours were yours?'),
    A(34, 7, 'Boundaries audit',
        'Where in the relationship do you avoid boundaries: tolerating the intolerable, avoiding a talk, not asking, sacrificing to keep peace? Apply the Second Date Rule ("if this had happened on date two, would there have been a date three?") and the Healthy Male Rule ("how would a healthy man handle this?").'),
    A(35, 7, 'When frustrated, ask',
        'Next time you feel resentful toward her, ask on paper: why did I invite this person into my life? What do I need to learn here? How does this look if it is a gift?'),
    A(36, 8, 'Honest look at intimacy',
        'Take an honest inventory of your intimate life: what is actually good, what you settle for, what you avoid, what you pretend is fine. Write it down without editing yourself.'),
    A(37, 8, 'Bring it into the light',
        'With a safe person or on paper first: your sexual history, the ways you have acted out, and the parts you have never told anyone. Secrets keep the shame alive; naming them drains it.'),
    A(38, 8, 'Own your side of it',
        'Practice being present in your own body and desire without fantasy, pornography or performance scripts. Notice where shame or distraction shows up; treat that as information, not failure.'),
    A(39, 8, 'Reset if needed',
        'If intimacy has become pressured, scorekept or avoidant, consider an agreed reset period with clear parameters, and use it to notice pursuing, resentment and what you have been using intimacy to avoid saying.'),
    A(40, 9, 'Do the scary thing',
        'Pick one concrete fear-item: ask for the raise, quit the dead job, start the project, have the conversation. Get support, repeat "no matter what happens, I will handle it", and do it.'),
    A(41, 9, 'Three wants',
        'Write down three things you want to make happen in your life, plus one personal affirmation that points at them. Post it where you will see it and tell a safe person.'),
    A(42, 9, 'Kill perfectionism',
        'Where does "it must be perfect / done right" stop you from starting or finishing? If success were guaranteed, what would you begin today? Begin it at "good enough".'),
    A(43, 9, 'Let people help',
        'List your helpers (friends, family, professionals). What help is missing? How do you block people from giving to you? Ask for help with one real thing this week.'),
    A(44, 9, 'Name your self-sabotage',
        'Identify how you sabotage yourself (procrastinating, not finishing, too many projects, excuses, other people\'s crises). Pick counter-rules: focus, do it now, finish, no excuses. Review weekly with someone.'),
    A(45, 9, 'Practice abundance',
        'Daily, briefly: picture a world with enough in it for you too: love, money, time, respect. Repeat until acting from scarcity starts to feel like the strange choice.'),
    A(46, 9, 'Write your own rules',
        'From the book\'s working rules ("If it frightens you, do it", "Don\'t settle", "Ask for what you want", "Do not tolerate the intolerable"...), pick the ones that land, add your own, and post them where you will see them every day.'),
];

// --- Day keys ---
// Check-ins are keyed by the LOCAL calendar day ('YYYY-MM-DD'): the day you
// lived, not the UTC day. Key arithmetic runs through UTC internally so DST
// shifts can never skip or double a day.

export function dateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export function shiftKey(key, deltaDays) {
    const [y, m, d] = key.split('-').map(Number);
    const t = Date.UTC(y, m - 1, d) + deltaDays * 86_400_000;
    return new Date(t).toISOString().slice(0, 10);
}

// --- Scoring ---
// A day is "kept" when at least GOAL of the six practices are done. Four of
// six is deliberate: perfection is the Nice Guy trap this tool exists to
// unlearn, but fewer than four means the day mostly ran on autopilot.

export const GOAL = 4;

export function dayScore(practices) {
    let score = 0;
    for (const p of PRACTICES) {
        if (practices && practices[p.key] === true) score++;
    }
    return score;
}

/**
 * Consecutive kept days (score >= GOAL) ending today, or ending yesterday
 * when today is not kept YET: an in-progress day never reads as a broken
 * streak, only a missed past day does.
 * @param {{day: string, practices: object}[]} checkins
 * @param {string} todayKey local day key for "now"
 */
export function streak(checkins, todayKey) {
    const keptDays = new Set(
        checkins.filter(c => dayScore(c.practices) >= GOAL).map(c => c.day)
    );
    let cursor = keptDays.has(todayKey) ? todayKey : shiftKey(todayKey, -1);
    let run = 0;
    while (keptDays.has(cursor)) {
        run++;
        cursor = shiftKey(cursor, -1);
    }
    return run;
}

/**
 * The last n calendar days ending today, oldest first, each with its day
 * score or null when nothing was logged. Feeds the progress wall.
 * @returns {{day: string, score: number|null}[]}
 */
export function lastNDays(checkins, todayKey, n) {
    const byDay = new Map(checkins.map(c => [c.day, c.practices]));
    const series = [];
    for (let i = n - 1; i >= 0; i--) {
        const key = shiftKey(todayKey, -i);
        series.push({ day: key, score: byDay.has(key) ? dayScore(byDay.get(key)) : null });
    }
    return series;
}

/**
 * Per-practice completion over the last n days, counting only days that were
 * actually logged; shows which practice keeps slipping. One entry per
 * practice, in PRACTICES order, carrying the label for rendering.
 * @returns {{key: string, label: string, done: number, days: number}[]}
 */
export function practiceRates(checkins, todayKey, n) {
    const floor = shiftKey(todayKey, -(n - 1));
    const window = checkins.filter(c => c.day >= floor && c.day <= todayKey);
    return PRACTICES.map(p => ({
        key: p.key,
        label: p.label,
        done: window.filter(c => c.practices && c.practices[p.key] === true).length,
        days: window.length,
    }));
}

/**
 * How often each pattern got caught in the last n days. Rising counts early
 * on mean awareness, not decline; the number to watch long-term is repeats
 * of the SAME pattern with no "what I'll do instead".
 * @param {{pattern: string, caught_at: string}[]} catches
 * @returns {{key: string, label: string, count: number}[]} in PATTERNS order
 */
export function catchCounts(catches, todayKey, n) {
    const floor = shiftKey(todayKey, -(n - 1));
    const inWindow = catches.filter(c => {
        const dayPart = String(c.caught_at).slice(0, 10);
        return dayPart >= floor && dayPart <= todayKey;
    });
    return PATTERNS.map(p => ({
        key: p.key,
        label: p.label,
        count: inWindow.filter(c => c.pattern === p.key).length,
    }));
}

/**
 * Workbook summary: how much of the 46-exercise program is done or under way.
 * @param {{num: number, status: string}[]} states
 */
export function activityProgress(states) {
    const valid = states.filter(s => s.num >= 1 && s.num <= ACTIVITIES.length);
    const done = valid.filter(s => s.status === 'done').length;
    const doing = valid.filter(s => s.status === 'doing').length;
    return {
        done,
        doing,
        total: ACTIVITIES.length,
        pct: Math.round((done / ACTIVITIES.length) * 100),
    };
}
