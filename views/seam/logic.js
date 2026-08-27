// SEAM // DOM-free decision logic.
//
// Everything script.js needs to think without a browser: the section, the
// cut, the cave, the seam, the bot, room codes and names, the event reducer
// and poll pacing. All three gamemodes (pass-the-phone, room, bot) import
// from here, and node --test tests/ exercises it directly.

// ------------------------------------------------------------------
//  The section
// ------------------------------------------------------------------

export const COLS = 7;
export const ROWS = 6;

/** Row 0 is the surface, row ROWS-1 the basement. */
export const EMPTY_BOARD = '.'.repeat(COLS * ROWS);

/** The bed a piece cut into this shaft would settle on, or -1 if it is full. */
export function dropRow(board, col) {
    for (let r = ROWS - 1; r >= 0; r--) {
        if (board[r * COLS + col] === '.') return r;
    }
    return -1;
}

/** The section with `seat`'s piece cut into `col`. Assumes the shaft has room. */
export function cut(board, col, seat) {
    const row = dropRow(board, col);
    if (row < 0) return board;
    const at = row * COLS + col;
    return board.slice(0, at) + seat + board.slice(at + 1);
}

/** A shaft that has taken all ROWS beds. */
export const columnFull = (board, col) => dropRow(board, col) < 0;

/** Every shaft topped out. */
export const isFull = (board) => !board.includes('.');

// ------------------------------------------------------------------
//  The seam
// ------------------------------------------------------------------

// Across the beds, down a shaft, and both dips. Only downward vectors are
// needed: every seam is found from its topmost, leftmost cell.
const SEAM_DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

/**
 * The four cells `seat` has struck a seam through, or null. Returns the cells
 * rather than a boolean because the plate draws a fault stroke along them.
 */
export function findSeam(board, seat) {
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            if (board[r * COLS + c] !== seat) continue;
            for (const [dr, dc] of SEAM_DIRS) {
                const endR = r + dr * 3;
                const endC = c + dc * 3;
                if (endR >= ROWS || endC < 0 || endC >= COLS) continue;
                const cells = [0, 1, 2, 3].map((i) => (r + dr * i) * COLS + (c + dc * i));
                if (cells.every((at) => board[at] === seat)) return cells;
            }
        }
    }
    return null;
}

// ------------------------------------------------------------------
//  The cave
// ------------------------------------------------------------------

/**
 * The bottom is drawn and the column caves: the basement bed is cut away and
 * every piece above it settles one bed down. This is the whole twist, and the
 * row-major surface-first encoding is chosen so it is one line. A legal
 * section is contiguous from the basement up, so nothing can be left floating.
 */
export const cave = (board) => '.'.repeat(COLS) + board.slice(0, COLS * (ROWS - 1));

// ------------------------------------------------------------------
//  A turn
// ------------------------------------------------------------------

// Mirrors CHARGES in seam-controller.php: change them in both.
export const CHARGES = 3;

/** The seat character a seat number writes into the section. */
export const seatChar = (seat) => (seat === 2 ? '2' : '1');
export const other = (seat) => (seat === 2 ? 1 : 2);

/** A fresh section. `starter` alternates between rematches. */
export function newGame({ starter = 1 } = {}) {
    return {
        board: EMPTY_BOARD,
        starter,
        turn: starter,
        charges: [CHARGES, CHARGES],
        cooling: [false, false],
        moves: 0,
        outcome: null,
        seams: [],
    };
}

/**
 * Why the moving seat may not cut into this shaft, or null if they may. The
 * single authority on legality: applyMove and legalMoves both read it, and
 * seam-controller.php mirrors it.
 */
export function moveError(state, col) {
    if (state.outcome !== null) return 'over';
    if (!Number.isInteger(col) || col < 0 || col >= COLS) return 'badShaft';
    if (!columnFull(state.board, col)) return null;

    // A full shaft is only playable by drawing the bottom, which costs a
    // permit and may never happen on two of a seat's own turns running. That
    // pair is what stops one seat caving every turn and deadlocking the game.
    const seat = state.turn;
    if (state.charges[seat - 1] <= 0) return 'noPermit';
    if (state.cooling[seat - 1]) return 'cooling';
    return null;
}

/** Every shaft the moving seat may cut into this turn. */
export const legalMoves = (state) =>
    Array.from({ length: COLS }, (_, c) => c).filter((c) => moveError(state, c) === null);

/**
 * One turn. Returns `{ok:true, state, caved}` or `{ok:false, reason}`; the
 * reason is a bare code the UI resolves against i18n/ui.json. Never mutates.
 */
export function applyMove(state, col) {
    const reason = moveError(state, col);
    if (reason !== null) return { ok: false, reason };

    const seat = state.turn;
    const next = {
        ...state,
        charges: [...state.charges],
        cooling: [...state.cooling],
    };

    // A full shaft is not a dead end, it is the twist: draw the bottom and
    // let the whole section cave, then land the piece on the freed surface.
    const caved = columnFull(state.board, col);
    if (caved) {
        next.charges[seat - 1] -= 1;
        next.board = cave(next.board);
    }

    next.board = cut(next.board, col, seatChar(seat));
    next.cooling[seat - 1] = caved;
    next.moves = state.moves + 1;
    next.turn = other(seat);
    resolve(next);

    return { ok: true, state: next, caved };
}

/**
 * Settle the section in place, immediately after a cut. A cave can strike for
 * either seat, or for both at once, so this looks at the whole section rather
 * than only at the seat that moved.
 */
function resolve(state) {
    const struck = [1, 2]
        .map((seat) => ({ seat, cells: findSeam(state.board, seatChar(seat)) }))
        .filter((s) => s.cells !== null);

    state.seams = struck;
    if (struck.length === 1) {
        state.outcome = struck[0].seat;
    } else if (struck.length === 2) {
        // Defensive only: a cave translates every survivor by the same vector,
        // so it cannot line four up for anyone but the seat whose piece just
        // landed. Kept because the server must never trust that reasoning.
        state.outcome = 'draw';
    } else if (legalMoves(state).length === 0) {
        // A full section and no permit to draw with: nobody strikes.
        state.outcome = 'draw';
    }
}

// ------------------------------------------------------------------
//  Room codes and names (mirror the validators in seam-controller.php)
// ------------------------------------------------------------------

export function normalizeCode(raw) {
    return String(raw ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}

export function isValidCode(code) {
    return /^[A-Z]{4}$/.test(code ?? '');
}

export function cleanName(raw) {
    return String(raw ?? '')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Counted in code points, so an emoji is one character rather than two. */
export function isValidName(raw) {
    const n = Array.from(cleanName(raw)).length;
    return n >= 1 && n <= 20;
}

// ------------------------------------------------------------------
//  The room reducer: poll events in, UI edges out
// ------------------------------------------------------------------

export function createRoomModel() {
    return { status: 'lobby', lastSeq: 0 };
}

/**
 * Folds one page of poll events into the model and returns the edges the UI
 * has to act on. The section itself never comes from here: the server owns
 * the board and the poll snapshot carries it. These are only the moments
 * worth animating, which is why `move` carries enough to replay the cut.
 *
 * Phase-carrying ops also move model.status, but the snapshot overrides it
 * afterwards, so a phone that resumed past these events still lands on the
 * right screen. Unknown types are ignored while the cursor still advances,
 * so an old client never desyncs or spins against a newer server.
 */
export function applyEvents(model, events, selfId) {
    const ops = [];
    for (const ev of events ?? []) {
        model.lastSeq = Math.max(model.lastSeq, ev.seq);
        switch (ev.type) {
            case 'deal':
                model.status = 'play';
                ops.push({ op: 'deal' });
                break;
            case 'move':
                ops.push({
                    op: 'move',
                    seat: ev.data?.seat ?? null,
                    col: ev.data?.col ?? null,
                    caved: ev.data?.caved === true,
                });
                break;
            case 'verdict':
                model.status = 'over';
                ops.push({ op: 'verdict' });
                break;
            case 'again':
                model.status = 'lobby';
                ops.push({ op: 'again' });
                break;
            case 'abandon':
                // A match needs two seats. Losing one voids the section and
                // puts the room back in the lobby so the shared link still
                // works for whoever turns up next.
                model.status = 'lobby';
                ops.push({ op: 'abandon' });
                break;
            case 'host':
                ops.push({ op: 'host', id: ev.data?.id ?? null, mine: ev.data?.id === selfId });
                break;
        }
    }
    return ops;
}

// ------------------------------------------------------------------
//  Poll pacing
// ------------------------------------------------------------------

/**
 * How long to wait before the next poll. A two seat board game has one
 * moment that matters: the stretch where the other seat is thinking and the
 * section can change without you. On your own turn nothing moves until you
 * move it, so that is the cheapest phase on the whole page.
 */
export function pollDelay({ status, hidden, failures, waiting }) {
    if (failures > 0) return Math.min(10000, 800 * 2 ** failures);
    // Unlike spy's grace countdown there is no deadline a phone cannot see
    // coming, so visibility beats everything below it.
    if (hidden) return 4000;
    if (status === 'lobby') return 1000;
    if (status === 'play') return waiting ? 900 : 3000;
    return 2500;
}

// ------------------------------------------------------------------
//  The bot
// ------------------------------------------------------------------

/**
 * How far ahead each opponent looks. Measured on a full self-play game: depth
 * 2 costs 12ms in the worst position, depth 4 costs 47ms and depth 5 costs
 * 174ms. Depth 6 was 673ms, which is a visible stall on a phone since the
 * search runs on the main thread, so the deepest opponent stops at 5.
 */
export const DEPTHS = { hand: 2, surveyor: 4, chief: 5 };

const WIN = 100000;

// Centre shafts sit in more windows, so they are worth more and they prune
// better when searched first.
const SEARCH_ORDER = [3, 2, 4, 1, 5, 0, 6];

/** Every straight run of four cells in the section, precomputed once. */
const WINDOWS = (() => {
    const out = [];
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            for (const [dr, dc] of SEAM_DIRS) {
                const endR = r + dr * 3;
                const endC = c + dc * 3;
                if (endR >= ROWS || endC < 0 || endC >= COLS) continue;
                out.push([0, 1, 2, 3].map((i) => (r + dr * i) * COLS + (c + dc * i)));
            }
        }
    }
    return out;
})();

// A window resting on the basement bed is one draw away from being erased,
// so it is worth less than the same shape higher up the section.
const FRAGILE = WINDOWS.map((cells) => (cells.some((at) => at >= COLS * (ROWS - 1)) ? 0.6 : 1));

const SHAPE = [0, 1, 10, 50, 0];

/** The section from `seat`'s point of view, in centipawns of nothing at all. */
export function evaluate(state, seat) {
    const me = seatChar(seat);
    const them = seatChar(other(seat));
    let score = 0;

    for (let w = 0; w < WINDOWS.length; w++) {
        let mine = 0;
        let theirs = 0;
        for (const at of WINDOWS[w]) {
            const v = state.board[at];
            if (v === me) mine++;
            else if (v === them) theirs++;
        }
        if (mine && theirs) continue;
        // Their threats count for slightly more, so a tie between building and
        // blocking is broken toward blocking.
        if (mine) score += SHAPE[mine] * FRAGILE[w];
        else if (theirs) score -= SHAPE[theirs] * 1.1 * FRAGILE[w];
    }

    for (let r = 0; r < ROWS; r++) {
        for (const [col, worth] of [[3, 3], [2, 1], [4, 1]]) {
            const v = state.board[r * COLS + col];
            if (v === me) score += worth;
            else if (v === them) score -= worth;
        }
    }

    // An unspent permit is a move nobody else can stop you making.
    score += 8 * (state.charges[seat - 1] - state.charges[other(seat) - 1]);
    return score;
}

function negamax(state, depth, alpha, beta) {
    if (state.outcome !== null) {
        if (state.outcome === 'draw') return 0;
        // Only the seat that just cut can have struck, so whoever is to move
        // in a settled section is the one who lost. Deeper wins score higher,
        // which makes the bot finish rather than dawdle.
        return state.outcome === state.turn ? WIN + depth : -(WIN + depth);
    }
    if (depth <= 0) return evaluate(state, state.turn);

    let best = -Infinity;
    for (const col of SEARCH_ORDER) {
        if (moveError(state, col) !== null) continue;
        const score = -negamax(applyMove(state, col).state, depth - 1, -beta, -alpha);
        if (score > best) best = score;
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
    }
    // No legal cut at all is a stalemate, which applyMove would already have
    // settled; reaching here means the section is finished.
    return best === -Infinity ? 0 : best;
}

/**
 * The shaft the machine cuts into, or -1 if the section is finished. Ties are
 * broken by the injected rng so the bot is deterministic under test and not
 * quite predictable in play.
 */
export function bestMove(state, { depth = DEPTHS.surveyor, rng = Math.random } = {}) {
    const options = SEARCH_ORDER.filter((col) => moveError(state, col) === null);
    if (options.length === 0) return -1;

    let best = [];
    let bestScore = -Infinity;
    for (const col of options) {
        const score = -negamax(applyMove(state, col).state, depth - 1, -Infinity, Infinity);
        if (score > bestScore) {
            bestScore = score;
            best = [col];
        } else if (score === bestScore) {
            best.push(col);
        }
    }
    return best[Math.floor(rng() * best.length)];
}

// ------------------------------------------------------------------
//  Translation
// ------------------------------------------------------------------
//
// i18n/ui.json is one row per string, one column per language. That is the
// whole system. Adding Croatian means adding an "hr" column to every row and
// listing it in `languages`; adding a word means adding a row. Nothing here
// knows which languages exist, and seam-controller.php reads the same file.

export const DEFAULT_LANG = 'en';

/** Fills {name} placeholders from a plain object. Unknown ones are left be. */
export function fillTemplate(text, vars) {
    if (!vars) return text;
    return String(text).replace(/\{(\w+)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole);
}

/**
 * One string from the table, in the requested language. Falls back to English
 * and then to the key itself, so a half-filled language still renders
 * something a person can act on rather than a blank control.
 */
export function resolveString(table, lang, key, vars) {
    const row = table?.strings?.[key];
    if (!row) return key;
    const pick = (code) => (typeof row[code] === 'string' && row[code] !== '' ? row[code] : null);
    const text = pick(lang) ?? pick(DEFAULT_LANG);
    return text === null ? key : fillTemplate(text, vars);
}

/** Binds a table and a language into the `t(key, vars)` the page calls. */
export function createTranslator(table, lang) {
    return (key, vars) => resolveString(table, lang, key, vars);
}

/** The languages a table declares, always with English present. */
export function tableLanguages(table) {
    const list = Array.isArray(table?.languages)
        ? table.languages.filter((l) => typeof l === 'string')
        : [];
    return list.length > 0 ? list : [DEFAULT_LANG];
}

/** Anything unrecognised becomes English, matching validateLang() in PHP. */
export function normalizeLang(raw, table) {
    const lang = String(raw ?? '').trim().toLowerCase();
    return tableLanguages(table).includes(lang) ? lang : DEFAULT_LANG;
}
