/* ChordCard: popover with a guitar chord diagram (SVG) and a strummed sound
   (Karplus-Strong via Web Audio). Fully local: open voicings for the common
   chords plus movable E-shape / A-shape barre templates for everything else,
   so it works offline and needs no API. Shared by the player, editor and
   analysis screens; styles live in views/music/style.css (.chord-card).

   Usage: ChordCard.show('F#m', anchorElement) */

const ChordCard = (function() {
  const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const TUNING_MIDI = [40, 45, 50, 55, 59, 64]; // E A D G B e

  const QUALITY_TONES = {
    maj: [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10],
    maj7: [0, 4, 7, 11], sus2: [0, 2, 7], sus4: [0, 5, 7], dim: [0, 3, 6],
    aug: [0, 4, 8], 5: [0, 7], add9: [0, 4, 7, 2], 6: [0, 4, 7, 9], m6: [0, 3, 7, 9],
  };

  // Open-position voicings: frets low E -> high e (-1 mute), matching fingers.
  // Key is "<pitch class>:<quality>".
  const OPEN = {
    '0:maj':  { frets: [-1, 3, 2, 0, 1, 0], fingers: [0, 3, 2, 0, 1, 0] },           // C
    '2:maj':  { frets: [-1, -1, 0, 2, 3, 2], fingers: [0, 0, 0, 1, 3, 2] },          // D
    '4:maj':  { frets: [0, 2, 2, 1, 0, 0], fingers: [0, 2, 3, 1, 0, 0] },            // E
    '7:maj':  { frets: [3, 2, 0, 0, 0, 3], fingers: [2, 1, 0, 0, 0, 3] },            // G
    '9:maj':  { frets: [-1, 0, 2, 2, 2, 0], fingers: [0, 0, 1, 2, 3, 0] },           // A
    '9:m':    { frets: [-1, 0, 2, 2, 1, 0], fingers: [0, 0, 2, 3, 1, 0] },           // Am
    '4:m':    { frets: [0, 2, 2, 0, 0, 0], fingers: [0, 2, 3, 0, 0, 0] },            // Em
    '2:m':    { frets: [-1, -1, 0, 2, 3, 1], fingers: [0, 0, 0, 2, 3, 1] },          // Dm
    '9:7':    { frets: [-1, 0, 2, 0, 2, 0], fingers: [0, 0, 2, 0, 3, 0] },           // A7
    '11:7':   { frets: [-1, 2, 1, 2, 0, 2], fingers: [0, 2, 1, 3, 0, 4] },           // B7
    '0:7':    { frets: [-1, 3, 2, 3, 1, 0], fingers: [0, 3, 2, 4, 1, 0] },           // C7
    '2:7':    { frets: [-1, -1, 0, 2, 1, 2], fingers: [0, 0, 0, 2, 1, 3] },          // D7
    '4:7':    { frets: [0, 2, 0, 1, 0, 0], fingers: [0, 2, 0, 1, 0, 0] },            // E7
    '7:7':    { frets: [3, 2, 0, 0, 0, 1], fingers: [3, 2, 0, 0, 0, 1] },            // G7
    '9:m7':   { frets: [-1, 0, 2, 0, 1, 0], fingers: [0, 0, 2, 0, 1, 0] },           // Am7
    '4:m7':   { frets: [0, 2, 2, 0, 3, 3], fingers: [0, 1, 2, 0, 3, 4] },            // Em7
    '2:m7':   { frets: [-1, -1, 0, 2, 1, 1], fingers: [0, 0, 0, 2, 1, 1] },          // Dm7
    '0:maj7': { frets: [-1, 3, 2, 0, 0, 0], fingers: [0, 3, 2, 0, 0, 0] },           // Cmaj7
    '2:maj7': { frets: [-1, -1, 0, 2, 2, 2], fingers: [0, 0, 0, 1, 1, 1] },          // Dmaj7
    '9:maj7': { frets: [-1, 0, 2, 1, 2, 0], fingers: [0, 0, 2, 1, 3, 0] },           // Amaj7
    '5:maj7': { frets: [-1, -1, 3, 2, 1, 0], fingers: [0, 0, 3, 2, 1, 0] },          // Fmaj7
    '9:sus2': { frets: [-1, 0, 2, 2, 0, 0], fingers: [0, 0, 1, 2, 0, 0] },           // Asus2
    '9:sus4': { frets: [-1, 0, 2, 2, 3, 0], fingers: [0, 0, 1, 2, 3, 0] },           // Asus4
    '2:sus2': { frets: [-1, -1, 0, 2, 3, 0], fingers: [0, 0, 0, 1, 3, 0] },          // Dsus2
    '2:sus4': { frets: [-1, -1, 0, 2, 3, 3], fingers: [0, 0, 0, 1, 2, 3] },          // Dsus4
    '4:sus4': { frets: [0, 2, 2, 2, 0, 0], fingers: [0, 1, 2, 3, 0, 0] },            // Esus4
    '0:add9': { frets: [-1, 3, 2, 0, 3, 0], fingers: [0, 2, 1, 0, 3, 0] },           // Cadd9
    '7:add9': { frets: [3, 2, 0, 2, 0, 3], fingers: [2, 1, 0, 3, 0, 4] },            // Gadd9
  };

  // Movable barre templates: fret values are relative, the barre sits at 1.
  // rootString: which string carries the root (6 = low E shape, 5 = A shape).
  const MOVABLE = {
    6: { // E-shapes, root pc at fret f is (4 + f) % 12
      maj:  { frets: [1, 3, 3, 2, 1, 1], fingers: [1, 3, 4, 2, 1, 1] },
      m:    { frets: [1, 3, 3, 1, 1, 1], fingers: [1, 3, 4, 1, 1, 1] },
      7:    { frets: [1, 3, 1, 2, 1, 1], fingers: [1, 3, 1, 2, 1, 1] },
      m7:   { frets: [1, 3, 1, 1, 1, 1], fingers: [1, 3, 1, 1, 1, 1] },
      maj7: { frets: [1, 3, 2, 2, 1, 1], fingers: [1, 4, 2, 3, 1, 1] },
      sus4: { frets: [1, 3, 3, 3, 1, 1], fingers: [1, 2, 3, 4, 1, 1] },
      5:    { frets: [1, 3, 3, -1, -1, -1], fingers: [1, 3, 4, 0, 0, 0] },
    },
    5: { // A-shapes, root pc at fret f is (9 + f) % 12
      maj:  { frets: [-1, 1, 3, 3, 3, 1], fingers: [0, 1, 2, 3, 4, 1] },
      m:    { frets: [-1, 1, 3, 3, 2, 1], fingers: [0, 1, 3, 4, 2, 1] },
      7:    { frets: [-1, 1, 3, 1, 3, 1], fingers: [0, 1, 3, 1, 4, 1] },
      m7:   { frets: [-1, 1, 3, 1, 2, 1], fingers: [0, 1, 3, 1, 2, 1] },
      maj7: { frets: [-1, 1, 3, 2, 3, 1], fingers: [0, 1, 3, 2, 4, 1] },
      sus2: { frets: [-1, 1, 3, 3, 1, 1], fingers: [0, 1, 3, 4, 1, 1] },
      sus4: { frets: [-1, 1, 3, 3, 4, 1], fingers: [0, 1, 2, 3, 4, 1] },
      dim:  { frets: [-1, 1, 2, 3, 2, -1], fingers: [0, 1, 2, 4, 3, 0] },
      5:    { frets: [-1, 1, 3, 3, -1, -1], fingers: [0, 1, 3, 4, 0, 0] },
    },
  };

  const GAPS = ['', 'N.C.', 'NC', '-'];

  function parse(name) {
    name = (name || '').trim();
    if (GAPS.includes(name)) return null;

    let bass = null;
    const slash = name.split('/');
    if (slash.length === 2) {
      name = slash[0];
      bass = slash[1];
    }

    const match = name.match(/^([A-G])([#b]?)(.*)$/);
    if (!match) return null;
    let pc = PC[match[1]];
    if (match[2] === '#') pc = (pc + 1) % 12;
    if (match[2] === 'b') pc = (pc + 11) % 12;

    const rest = match[3];
    let quality;
    if (rest === '' || rest === 'maj') quality = 'maj';
    else if (/^maj7/.test(rest)) quality = 'maj7';
    else if (/^m7b5|^m7-5/.test(rest)) quality = 'dim';
    else if (/^m7/.test(rest)) quality = 'm7';
    else if (/^(m|min)(?!aj)/.test(rest)) quality = 'm';
    else if (/^7/.test(rest)) quality = '7';
    else if (/^sus2/.test(rest)) quality = 'sus2';
    else if (/^sus4?/.test(rest)) quality = 'sus4';
    else if (/^(dim|°|o7?)/.test(rest)) quality = 'dim';
    else if (/^(aug|\+)/.test(rest)) quality = 'aug';
    else if (/^add9/.test(rest)) quality = 'add9';
    else if (/^5$/.test(rest)) quality = '5';
    else if (/^6/.test(rest)) quality = '6';
    else quality = 'maj'; // unknown extension: fall back to the major shape

    return { pc, quality, bass, requested: (name + (bass ? '/' + bass : '')) };
  }

  // simplification chain used when no shape exists for the exact quality
  const FALLBACK = { add9: 'maj', 6: 'maj', m6: 'm', aug: 'maj', sus2: 'sus4' };

  function findVoicing(pc, quality) {
    let q = quality;
    for (let hop = 0; hop < 3 && q; hop++) {
      const open = OPEN[`${pc}:${q}`];
      if (open) return { frets: open.frets, fingers: open.fingers, baseFret: 1, quality: q };

      const candidates = [];
      [6, 5].forEach(rootString => {
        const shape = MOVABLE[rootString][q];
        if (!shape) return;
        const rootPc = rootString === 6 ? 4 : 9;
        let fret = (pc - rootPc + 12) % 12;
        if (fret === 0) fret = 12;
        candidates.push({ frets: shape.frets, fingers: shape.fingers, baseFret: fret, quality: q });
      });
      if (candidates.length) {
        candidates.sort((a, b) => a.baseFret - b.baseFret);
        return candidates[0];
      }
      q = FALLBACK[q];
    }
    return null;
  }

  function toneNames(pc, quality) {
    const intervals = QUALITY_TONES[quality] || QUALITY_TONES.maj;
    return intervals.map(i => NOTE_NAMES[(pc + i) % 12]);
  }

  // ---- SVG diagram ---------------------------------------------------------

  function diagramSvg(voicing) {
    const left = 18, top = 26, stringGap = 15, fretGap = 19, nFrets = 4;
    const width = left * 2 + stringGap * 5;
    const height = top + fretGap * nFrets + 12;
    const x = s => left + s * stringGap;
    const y = f => top + f * fretGap;
    let svg = `<svg viewBox="0 0 ${width} ${height}" width="${width * 1.5}" height="${height * 1.5}" role="img">`;

    // grid
    for (let s = 0; s < 6; s++) {
      svg += `<line x1="${x(s)}" y1="${top}" x2="${x(s)}" y2="${y(nFrets)}" stroke="currentColor" stroke-width="1"/>`;
    }
    for (let f = 0; f <= nFrets; f++) {
      svg += `<line x1="${left}" y1="${y(f)}" x2="${x(5)}" y2="${y(f)}" stroke="currentColor" stroke-width="1"/>`;
    }
    if (voicing.baseFret === 1) {
      svg += `<rect x="${left - 1}" y="${top - 3.5}" width="${stringGap * 5 + 2}" height="4" fill="currentColor"/>`;
    } else {
      svg += `<text x="${x(5) + 5}" y="${y(1) - 5}" font-size="9" font-family="monospace" fill="currentColor">${voicing.baseFret}fr</text>`;
    }

    voicing.frets.forEach((fret, s) => {
      if (fret < 0) {
        svg += `<text x="${x(s)}" y="${top - 8}" font-size="9" font-family="monospace" text-anchor="middle" fill="currentColor">x</text>`;
      } else if (fret === 0) {
        svg += `<circle cx="${x(s)}" cy="${top - 11}" r="3.2" fill="none" stroke="currentColor" stroke-width="1.2"/>`;
      } else {
        const cy = y(fret) - fretGap / 2;
        svg += `<circle cx="${x(s)}" cy="${cy}" r="6" fill="currentColor"/>`;
        const finger = voicing.fingers[s];
        if (finger > 0) {
          svg += `<text x="${x(s)}" y="${cy + 3}" font-size="8.5" font-family="monospace" text-anchor="middle" fill="var(--card, #fffdf8)">${finger}</text>`;
        }
      }
    });

    return svg + '</svg>';
  }

  // ---- Sound (Karplus-Strong pluck per string, staggered strum) ------------

  let audioCtx = null;

  function pluckBuffer(ctx, freq, seconds) {
    const sr = ctx.sampleRate;
    const period = Math.max(2, Math.round(sr / freq));
    const length = Math.floor(sr * seconds);
    const buffer = ctx.createBuffer(1, length, sr);
    const data = buffer.getChannelData(0);
    for (let i = 0; i <= period; i++) data[i] = Math.random() * 2 - 1;
    for (let i = period + 1; i < length; i++) {
      data[i] = 0.996 * 0.5 * (data[i - period] + data[i - period - 1]);
    }
    return buffer;
  }

  function strum(voicing) {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const master = audioCtx.createGain();
    master.gain.value = 0.55;
    master.connect(audioCtx.destination);
    const start = audioCtx.currentTime + 0.02;

    voicing.frets.forEach((fret, s) => {
      if (fret < 0) return;
      const midi = TUNING_MIDI[s] + (fret === 0 ? 0 : fret + voicing.baseFret - 1);
      const freq = 440 * Math.pow(2, (midi - 69) / 12);
      const source = audioCtx.createBufferSource();
      source.buffer = pluckBuffer(audioCtx, freq, 1.8);
      const gain = audioCtx.createGain();
      gain.gain.value = 0.3;
      source.connect(gain);
      gain.connect(master);
      source.start(start + s * 0.045);
    });
  }

  // ---- Popover ---------------------------------------------------------------

  let cardEl = null;
  let currentVoicing = null;

  function ensureCard() {
    if (cardEl) return cardEl;
    cardEl = document.createElement('div');
    cardEl.className = 'chord-card hidden';
    cardEl.innerHTML =
      '<div class="chord-card__head">' +
      '  <span class="chord-card__name"></span>' +
      '  <button class="chord-card__close" aria-label="Close"><i class="fas fa-xmark"></i></button>' +
      '</div>' +
      '<div class="chord-card__diagram"></div>' +
      '<p class="chord-card__tones"></p>' +
      '<p class="chord-card__note hidden"></p>' +
      '<button class="chord-card__play"><i class="fas fa-play"></i> Strum it</button>';
    document.body.appendChild(cardEl);

    cardEl.querySelector('.chord-card__close').addEventListener('click', hide);
    cardEl.querySelector('.chord-card__play').addEventListener('click', () => {
      if (currentVoicing) strum(currentVoicing);
    });
    document.addEventListener('click', e => {
      if (!cardEl.classList.contains('hidden') && !cardEl.contains(e.target) && !e.target.closest('[data-chord-anchor]')) {
        hide();
      }
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') hide();
    });
    return cardEl;
  }

  function hide() {
    if (cardEl) cardEl.classList.add('hidden');
    currentVoicing = null;
  }

  function show(name, anchorEl) {
    const parsed = parse(name);
    if (!parsed) return;
    const card = ensureCard();

    const voicing = findVoicing(parsed.pc, parsed.quality);
    currentVoicing = voicing;

    card.querySelector('.chord-card__name').textContent = parsed.requested;
    card.querySelector('.chord-card__tones').textContent =
      'notes: ' + toneNames(parsed.pc, parsed.quality).join(' · ') + (parsed.bass ? ` · bass ${parsed.bass}` : '');

    const noteEl = card.querySelector('.chord-card__note');
    const diagramEl = card.querySelector('.chord-card__diagram');
    const playBtn = card.querySelector('.chord-card__play');

    if (voicing) {
      diagramEl.innerHTML = diagramSvg(voicing);
      playBtn.classList.remove('hidden');
      if (voicing.quality !== parsed.quality) {
        noteEl.textContent = `no ${parsed.quality} shape on file, showing the ${voicing.quality === 'maj' ? 'major' : voicing.quality} voicing`;
        noteEl.classList.remove('hidden');
      } else {
        noteEl.classList.add('hidden');
      }
    } else {
      diagramEl.innerHTML = '';
      playBtn.classList.add('hidden');
      noteEl.textContent = 'No diagram available for this one.';
      noteEl.classList.remove('hidden');
    }

    // place near the anchor, clamped to the viewport
    card.classList.remove('hidden');
    const rect = anchorEl.getBoundingClientRect();
    const cw = card.offsetWidth, ch = card.offsetHeight;
    let left = rect.left + rect.width / 2 - cw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - cw - 8));
    let top = rect.bottom + 10;
    if (top + ch > window.innerHeight - 8) top = rect.top - ch - 10;
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(Math.max(8, top))}px`;
  }

  return { show, hide, parse, findVoicing };
})();
