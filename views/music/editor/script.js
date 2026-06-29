document.addEventListener('DOMContentLoaded', function() {
  const API = '../../../app/controllers/music-controller.php';
  const AUDIO_BASE = '../../../assets/music/';
  const QUICK_CHORDS = ['C', 'G', 'D', 'A', 'E', 'F', 'Am', 'Em', 'Dm', 'Bm', 'B7', 'N.C.'];

  const trackSelect = document.getElementById('trackSelect');
  const importBtn   = document.getElementById('importBtn');
  const exportBtn   = document.getElementById('exportBtn');
  const saveBtn     = document.getElementById('saveBtn');
  const statusLine  = document.getElementById('statusLine');
  const deckPanel   = document.getElementById('deckPanel');
  const workPanel   = document.getElementById('workPanel');
  const markersEl   = document.getElementById('markers');
  const playBtn     = document.getElementById('playBtn');
  const curTimeEl   = document.getElementById('curTime');
  const totTimeEl   = document.getElementById('totTime');
  const chordInput  = document.getElementById('chordInput');
  const tapBtn      = document.getElementById('tapBtn');
  const quickRow    = document.getElementById('quickChords');
  const chordList   = document.getElementById('chordList');
  const lyricsInput = document.getElementById('lyricsInput');
  const wordGrid    = document.getElementById('wordGrid');
  const tabEdit     = document.getElementById('tabEdit');
  const tabAnchor   = document.getElementById('tabAnchor');
  const anchorHint  = document.getElementById('anchorHint');

  const benchMarquee = document.getElementById('benchMarquee');
  const bmTexts = [document.getElementById('bmText1'), document.getElementById('bmText2')];
  const deckRow = document.getElementById('deckRow');

  const importDialog = document.getElementById('importDialog');
  const importText   = document.getElementById('importText');
  const importFile   = document.getElementById('importFile');
  const importApply  = document.getElementById('importApply');
  const importCancel = document.getElementById('importCancel');
  const importError  = document.getElementById('importError');

  let trackKey = null;
  let chords = [];          // [{ time, chord, line?, word? }] always sorted by time
  let selected = -1;        // index into chords
  let duration = 0;
  let isPlaying = false;
  let dirty = false;
  let audioReady = false;

  const wavesurfer = WaveSurfer.create({
    container: '#editorWaveform',
    waveColor: 'rgba(28, 26, 23, 0.22)',
    progressColor: '#d4451f',
    cursorColor: '#1c1a17',
    barWidth: 2,
    barRadius: 2,
    cursorWidth: 2,
    height: 110,
    responsive: true,
    hideScrollbar: true,
    normalize: true
  });

  // ---- Status / state helpers --------------------------------------------

  function setStatus(message, kind) {
    statusLine.textContent = message;
    statusLine.classList.remove('status-line--error', 'status-line--ok');
    if (kind === 'error') statusLine.classList.add('status-line--error');
    if (kind === 'ok') statusLine.classList.add('status-line--ok');
  }

  function markDirty() {
    dirty = true;
    saveBtn.disabled = false;
    saveBtn.innerHTML = '<i class="fas fa-floppy-disk"></i> Save *';
    refreshMarquee();
  }

  function markClean() {
    dirty = false;
    saveBtn.innerHTML = '<i class="fas fa-floppy-disk"></i> Save';
    refreshMarquee();
  }

  function refreshMarquee() {
    let text = 'Pick a track to start splicing the tape';
    if (trackKey) {
      const option = trackSelect.options[trackSelect.selectedIndex];
      const name = option ? option.textContent : trackKey;
      const bits = [`✎ ${name}`, `${chords.length} chord event${chords.length === 1 ? '' : 's'}`];
      if (dirty) bits.push('unsaved changes');
      text = bits.join('  //  ');
    }
    bmTexts.forEach(el => { if (el) el.textContent = text; });
  }

  function formatPrecise(seconds) {
    const m = Math.floor(seconds / 60);
    const s = (seconds % 60).toFixed(1).padStart(4, '0');
    return `${m}:${s}`;
  }

  function sortChords() {
    const current = chords[selected];
    chords.sort((a, b) => a.time - b.time);
    selected = current ? chords.indexOf(current) : -1;
  }

  // ---- Track list ----------------------------------------------------------

  fetch(AUDIO_BASE + 'tracks.json')
    .then(r => r.json())
    .then(data => {
      ['acoustic', 'electric'].forEach(category => {
        const group = document.createElement('optgroup');
        group.label = category.charAt(0).toUpperCase() + category.slice(1);
        (data[category] || []).forEach(track => {
          const option = document.createElement('option');
          option.value = `${category}/${track.file}`;
          option.textContent = track.name;
          group.appendChild(option);
        });
        trackSelect.appendChild(group);
      });

      const requested = new URLSearchParams(location.search).get('track');
      if (requested && [...trackSelect.options].some(o => o.value === requested)) {
        trackSelect.value = requested;
        loadTrack(requested);
      }
    })
    .catch(() => setStatus('Could not load the track list.', 'error'));

  trackSelect.addEventListener('change', function() {
    if (!this.value) return;
    if (dirty && !confirm('You have unsaved changes. Discard them?')) {
      this.value = trackKey || '';
      return;
    }
    loadTrack(this.value);
  });

  function loadTrack(key) {
    trackKey = key;
    chords = [];
    selected = -1;
    audioReady = false;
    lyricsInput.value = '';
    markClean();
    saveBtn.disabled = true;
    importBtn.disabled = false;
    exportBtn.disabled = false;

    deckPanel.classList.remove('hidden');
    workPanel.classList.remove('hidden');
    setStatus('Loading audio...');

    if (isPlaying) togglePlay();
    wavesurfer.load(AUDIO_BASE + key);

    fetch(`${API}?resource=sync&track=${encodeURIComponent(key)}`)
      .then(r => {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        if (data) {
          lyricsInput.value = data.lyrics || '';
          chords = (data.chords || []).slice().sort((a, b) => a.time - b.time);
          setStatus(`Loaded saved sheet (${chords.length} chord events).`, 'ok');
        } else {
          setStatus('No saved sheet for this track yet. Fresh tape.');
        }
        renderAll();
      })
      .catch(() => {
        setStatus('Backend offline: editing works, but use Export instead of Save.', 'error');
        renderAll();
      });
  }

  // ---- Transport ------------------------------------------------------------

  wavesurfer.on('ready', function() {
    audioReady = true;
    duration = wavesurfer.getDuration();
    totTimeEl.textContent = formatPrecise(duration);
    renderMarkers();
  });

  wavesurfer.on('audioprocess', tick);
  wavesurfer.on('seek', tick);

  wavesurfer.on('finish', function() {
    isPlaying = false;
    playBtn.querySelector('i').classList.replace('fa-pause', 'fa-play');
    setRolling(false);
  });

  function setRolling(rolling) {
    benchMarquee.setAttribute('data-playing', rolling ? 'true' : 'false');
    deckRow.classList.toggle('is-playing', rolling);
  }

  wavesurfer.on('error', function(err) {
    setStatus('Could not load the audio: ' + err, 'error');
  });

  let lastNowIndex = -1;

  function tick() {
    const t = wavesurfer.getCurrentTime();
    curTimeEl.textContent = formatPrecise(t);

    // highlight the chord row currently under the playhead
    let now = -1;
    for (let i = 0; i < chords.length; i++) {
      if (chords[i].time <= t) now = i; else break;
    }
    if (now === lastNowIndex) return;
    lastNowIndex = now;
    [...chordList.querySelectorAll('.chord-row')].forEach((row, i) => {
      row.classList.toggle('is-now', i === now);
    });
  }

  function togglePlay() {
    if (!audioReady) return;
    isPlaying = !isPlaying;
    wavesurfer.playPause();
    playBtn.querySelector('i').classList.replace(
      isPlaying ? 'fa-play' : 'fa-pause',
      isPlaying ? 'fa-pause' : 'fa-play'
    );
    setRolling(isPlaying);
  }

  playBtn.addEventListener('click', togglePlay);

  document.querySelectorAll('[data-skip]').forEach(button => {
    button.addEventListener('click', function() {
      if (audioReady) wavesurfer.skip(parseFloat(this.dataset.skip));
    });
  });

  // ---- Chord events -----------------------------------------------------------

  QUICK_CHORDS.forEach(name => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = name;
    chip.title = `Tap ${name} at the playhead`;
    chip.addEventListener('click', () => {
      chordInput.value = name;
      tapChord(name);
    });
    quickRow.appendChild(chip);
  });

  function tapChord(name) {
    name = (name || chordInput.value).trim();
    if (!name) {
      chordInput.focus();
      setStatus('Type a chord name first (e.g. Am).', 'error');
      return;
    }
    if (!audioReady) {
      setStatus('Wait for the audio to load before tapping chords.', 'error');
      return;
    }
    const event = { time: Math.round(wavesurfer.getCurrentTime() * 100) / 100, chord: name };
    chords.push(event);
    sortChords();
    selected = chords.indexOf(event);
    markDirty();
    renderAll();
  }

  tapBtn.addEventListener('click', () => tapChord());
  chordInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      tapChord();
    }
  });

  function selectChord(index) {
    selected = index;
    if (index >= 0) chordInput.value = chords[index].chord;
    renderChordList();
    renderMarkers();
    renderWordGrid();
  }

  function nudgeChord(index, delta) {
    chords[index].time = Math.min(Math.max(0, chords[index].time + delta), duration || Infinity);
    chords[index].time = Math.round(chords[index].time * 100) / 100;
    sortChords();
    markDirty();
    renderAll();
  }

  function renderChordList() {
    chordList.innerHTML = '';
    lastNowIndex = -2; // rows were rebuilt; force the playhead highlight to re-apply
    if (!chords.length) {
      const msg = document.createElement('p');
      msg.className = 'chordsheet__message';
      msg.textContent = 'No chords yet. Play the track and tap chords as you hear them, or import a JSON file.';
      chordList.appendChild(msg);
      return;
    }

    chords.forEach((event, index) => {
      const row = document.createElement('div');
      row.className = 'chord-row' + (index === selected ? ' is-selected' : '');
      row.addEventListener('click', () => selectChord(index));

      const time = document.createElement('button');
      time.className = 'chord-row__time';
      time.textContent = formatPrecise(event.time);
      time.title = 'Jump the playhead here';
      time.addEventListener('click', e => {
        e.stopPropagation();
        if (audioReady && duration) wavesurfer.seekTo(event.time / duration);
        selectChord(index);
      });

      const name = document.createElement('span');
      name.className = 'chord-row__name';
      name.textContent = event.chord;
      name.setAttribute('data-chord-anchor', '');
      name.title = 'Show the chord diagram';
      name.addEventListener('click', e => {
        e.stopPropagation();
        // show first: selectChord rebuilds the list and detaches e.target
        ChordCard.show(event.chord, e.target);
        selectChord(index);
      });

      const anchor = document.createElement('span');
      anchor.className = 'chord-row__anchor';
      anchor.textContent = Number.isInteger(event.line) && Number.isInteger(event.word)
        ? `L${event.line + 1}:W${event.word + 1}`
        : '';

      const tools = document.createElement('span');
      tools.className = 'chord-row__tools';

      const mkTool = (label, title, onClick, danger) => {
        const b = document.createElement('button');
        b.className = 'btn-mini' + (danger ? ' btn-mini--danger' : '');
        b.innerHTML = label;
        b.title = title;
        b.addEventListener('click', e => {
          e.stopPropagation();
          onClick();
        });
        return b;
      };

      tools.appendChild(mkTool('-0.1', 'Nudge 0.1s earlier', () => nudgeChord(index, -0.1)));
      tools.appendChild(mkTool('+0.1', 'Nudge 0.1s later', () => nudgeChord(index, 0.1)));
      tools.appendChild(mkTool('<i class="fas fa-crosshairs"></i>', 'Snap to the playhead', () => {
        chords[index].time = Math.round(wavesurfer.getCurrentTime() * 100) / 100;
        sortChords();
        markDirty();
        renderAll();
      }));
      tools.appendChild(mkTool('<i class="fas fa-xmark"></i>', 'Delete this chord', () => {
        chords.splice(index, 1);
        if (selected === index) selected = -1;
        else if (selected > index) selected--;
        markDirty();
        renderAll();
      }, true));

      row.appendChild(time);
      row.appendChild(name);
      row.appendChild(anchor);
      row.appendChild(tools);
      chordList.appendChild(row);
    });
  }

  function renderMarkers() {
    markersEl.innerHTML = '';
    if (!duration) return;
    chords.forEach((event, index) => {
      const marker = document.createElement('div');
      marker.className = 'marker' + (index === selected ? ' is-selected' : '');
      marker.style.left = `${(event.time / duration) * 100}%`;

      const flag = document.createElement('span');
      flag.className = 'marker__flag';
      flag.textContent = event.chord;
      flag.title = `${event.chord} @ ${formatPrecise(event.time)}`;
      flag.addEventListener('click', e => {
        e.stopPropagation();
        selectChord(index);
        wavesurfer.seekTo(event.time / duration);
      });

      marker.appendChild(flag);
      markersEl.appendChild(marker);
    });
  }

  // ---- Lyrics + anchoring ------------------------------------------------------

  lyricsInput.addEventListener('input', function() {
    markDirty();
  });

  tabEdit.addEventListener('click', () => setAnchorMode(false));
  tabAnchor.addEventListener('click', () => setAnchorMode(true));

  function setAnchorMode(on) {
    tabEdit.classList.toggle('is-active', !on);
    tabAnchor.classList.toggle('is-active', on);
    lyricsInput.classList.toggle('hidden', on);
    wordGrid.classList.toggle('hidden', !on);
    anchorHint.textContent = on
      ? 'Select a chord on the left, then click the word it lands on. Click again to unanchor.'
      : 'Switch to Anchor mode, select a chord on the left, then click the word it lands on.';
    if (on) renderWordGrid();
  }

  function renderWordGrid() {
    if (wordGrid.classList.contains('hidden')) return;
    wordGrid.innerHTML = '';

    const lines = lyricsInput.value.replace(/\r/g, '').split('\n');
    if (!lines.some(l => l.trim())) {
      const msg = document.createElement('p');
      msg.className = 'chordsheet__message';
      msg.textContent = 'No lyrics yet. Switch to Edit and paste them first.';
      wordGrid.appendChild(msg);
      return;
    }

    const anchors = {};
    chords.forEach((event, index) => {
      if (Number.isInteger(event.line) && Number.isInteger(event.word)) {
        anchors[`${event.line}:${event.word}`] = index;
      }
    });

    lines.forEach((line, lineIndex) => {
      const words = line.split(/\s+/).filter(Boolean);
      if (!words.length) {
        const gap = document.createElement('div');
        gap.className = 'wg-break';
        wordGrid.appendChild(gap);
        return;
      }

      const lineEl = document.createElement('div');
      lineEl.className = 'wg-line';

      words.forEach((word, wordIndex) => {
        const key = `${lineIndex}:${wordIndex}`;
        const anchoredIndex = anchors[key];

        const button = document.createElement('button');
        button.className = 'wg-word'
          + (anchoredIndex !== undefined ? ' is-anchored' : '')
          + (anchoredIndex !== undefined && anchoredIndex === selected ? ' is-selected-anchor' : '');

        const chordLabel = document.createElement('span');
        chordLabel.className = 'wg-word__chord';
        chordLabel.textContent = anchoredIndex !== undefined ? chords[anchoredIndex].chord : ' ';

        const text = document.createElement('span');
        text.textContent = word;

        button.appendChild(chordLabel);
        button.appendChild(text);
        button.addEventListener('click', () => anchorWord(lineIndex, wordIndex, anchoredIndex));
        lineEl.appendChild(button);
      });

      wordGrid.appendChild(lineEl);
    });
  }

  function anchorWord(lineIndex, wordIndex, anchoredIndex) {
    if (selected < 0) {
      // no chord selected: clicking an anchored word selects its chord
      if (anchoredIndex !== undefined) selectChord(anchoredIndex);
      else setStatus('Select a chord event first, then click the word it lands on.', 'error');
      return;
    }

    const event = chords[selected];
    if (event.line === lineIndex && event.word === wordIndex) {
      delete event.line;
      delete event.word;
    } else {
      // a word holds at most one chord; steal it if another event was anchored here
      if (anchoredIndex !== undefined && anchoredIndex !== selected) {
        delete chords[anchoredIndex].line;
        delete chords[anchoredIndex].word;
      }
      event.line = lineIndex;
      event.word = wordIndex;
    }
    markDirty();
    renderChordList();
    renderWordGrid();
  }

  function renderAll() {
    renderChordList();
    renderMarkers();
    renderWordGrid();
    renderSuggestions();
    refreshMarquee();
  }

  // ---- Next-chord suggestions (local theory engine) -----------------------
  // Hooktheory-style "what usually comes next": infer the key from the chords
  // used so far, map the last chord to a scale degree, then look up common
  // follow-up degrees. No network, no account needed.

  const suggestBlock = document.getElementById('suggestBlock');
  const suggestRow   = document.getElementById('suggestRow');
  const keyGuess     = document.getElementById('keyGuess');

  const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  // diatonic triads as offset-from-tonic -> quality
  const DIATONIC = {
    major: { 0: 'maj', 2: 'm', 4: 'm', 5: 'maj', 7: 'maj', 9: 'm', 11: 'dim' },
    minor: { 0: 'm', 2: 'dim', 3: 'maj', 5: 'm', 7: 'm', 8: 'maj', 10: 'maj' },
  };
  // common follow-up degrees (offsets) per degree, roughly by popularity
  const NEXT = {
    major: { 0: [5, 7, 9, 2], 2: [7, 5, 0], 4: [9, 5, 0], 5: [7, 0, 2, 9], 7: [0, 9, 5], 9: [5, 2, 7, 0], 11: [0] },
    minor: { 0: [5, 8, 10, 7], 2: [7, 0], 3: [8, 5, 10], 5: [7, 0, 10], 7: [0, 8, 5], 8: [3, 5, 10, 0], 10: [3, 0, 5] },
  };
  const ROMAN_MAJOR = { 0: 'I', 2: 'ii', 4: 'iii', 5: 'IV', 7: 'V', 9: 'vi', 11: 'vii°' };
  const ROMAN_MINOR = { 0: 'i', 2: 'ii°', 3: 'III', 5: 'iv', 7: 'v', 8: 'VI', 10: 'VII' };

  function inferKey(parsedChords) {
    let best = null;
    ['major', 'minor'].forEach(mode => {
      for (let tonic = 0; tonic < 12; tonic++) {
        let score = 0;
        const TRIAD = { maj7: 'maj', m7: 'm', 7: 'maj', add9: 'maj', 6: 'maj', m6: 'm', sus2: 'maj', sus4: 'maj' };
        parsedChords.forEach(({ pc, quality }, i) => {
          const offset = (pc - tonic + 12) % 12;
          const expected = DIATONIC[mode][offset];
          const q = TRIAD[quality] || quality;
          if (expected && expected === q) {
            score += 1;
            if (offset === 0) score += 0.5;              // tonic chords are strong evidence
            if (i === 0 && offset === 0) score += 0.5;   // especially as the opener
          }
        });
        if (!best || score > best.score) best = { tonic, mode, score };
      }
    });
    return best && best.score >= 2 ? best : null;
  }

  function renderSuggestions() {
    const parsed = chords
      .map(e => ChordCard.parse(e.chord))
      .filter(p => p && p.quality !== '5');
    if (parsed.length < 2) {
      suggestBlock.classList.add('hidden');
      return;
    }

    const key = inferKey(parsed);
    if (!key) {
      suggestBlock.classList.add('hidden');
      return;
    }

    const roman = key.mode === 'major' ? ROMAN_MAJOR : ROMAN_MINOR;
    const last = parsed[parsed.length - 1];
    const lastOffset = (last.pc - key.tonic + 12) % 12;
    let offsets = NEXT[key.mode][lastOffset];
    if (!offsets) offsets = key.mode === 'major' ? [0, 5, 7, 9] : [0, 5, 8, 10];

    keyGuess.textContent = `// sounds like ${NOTE_NAMES[key.tonic]} ${key.mode}`;
    suggestRow.innerHTML = '';
    offsets.slice(0, 4).forEach(offset => {
      const quality = DIATONIC[key.mode][offset];
      if (quality === 'dim') return; // rarely what a guitarist reaches for
      const name = NOTE_NAMES[(key.tonic + offset) % 12] + (quality === 'm' ? 'm' : '');
      const chip = document.createElement('button');
      chip.className = 'chip chip--suggest';
      chip.innerHTML = `${name} <span class="chip__degree">${roman[offset]}</span>`;
      chip.title = `Tap ${name} at the playhead`;
      chip.addEventListener('click', () => {
        chordInput.value = name;
        tapChord(name);
      });
      suggestRow.appendChild(chip);
    });
    suggestBlock.classList.remove('hidden');
  }

  // ---- Save / import / export ------------------------------------------------

  saveBtn.addEventListener('click', function() {
    if (!trackKey) return;
    saveBtn.disabled = true;
    setStatus('Saving...');

    fetch(API + '?resource=sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ track_key: trackKey, lyrics: lyricsInput.value, chords: chords })
    })
      .then(r => r.json().then(body => ({ ok: r.ok, body })))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || 'Save failed');
        markClean();
        setStatus(`Saved (${body.chords.length} chord events).`, 'ok');
      })
      .catch(error => {
        saveBtn.disabled = false;
        setStatus('Save failed: ' + error.message, 'error');
      });
  });

  exportBtn.addEventListener('click', function() {
    if (!trackKey) return;
    const payload = { track_key: trackKey, lyrics: lyricsInput.value, chords: chords };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = trackKey.split('/').pop().replace(/\.mp3$/i, '') + '.chords.json';
    link.click();
    URL.revokeObjectURL(link.href);
  });

  importBtn.addEventListener('click', function() {
    importText.value = '';
    importError.classList.add('hidden');
    importDialog.showModal();
  });

  importCancel.addEventListener('click', () => importDialog.close());

  importFile.addEventListener('change', function() {
    const file = this.files[0];
    if (!file) return;
    file.text().then(text => { importText.value = text; });
    this.value = '';
  });

  importApply.addEventListener('click', function() {
    importError.classList.add('hidden');
    let parsed;
    try {
      parsed = JSON.parse(importText.value);
    } catch (e) {
      importError.textContent = 'That is not valid JSON: ' + e.message;
      importError.classList.remove('hidden');
      return;
    }

    const rawChords = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.chords) ? parsed.chords : null;
    if (!rawChords) {
      importError.textContent = 'Expected an array of { time, chord } objects, or an export with a "chords" key.';
      importError.classList.remove('hidden');
      return;
    }

    const clean = rawChords
      .filter(e => e && typeof e.time === 'number' && e.time >= 0 && typeof e.chord === 'string' && e.chord.trim())
      .map(e => {
        const entry = { time: Math.round(e.time * 100) / 100, chord: e.chord.trim().slice(0, 16) };
        if (Number.isInteger(e.line) && e.line >= 0) entry.line = e.line;
        if (Number.isInteger(e.word) && e.word >= 0) entry.word = e.word;
        return entry;
      });

    if (!clean.length) {
      importError.textContent = 'No usable chord events found in that JSON.';
      importError.classList.remove('hidden');
      return;
    }

    chords = clean.sort((a, b) => a.time - b.time);
    selected = -1;
    if (!Array.isArray(parsed) && typeof parsed.lyrics === 'string' && parsed.lyrics.trim()) {
      lyricsInput.value = parsed.lyrics;
    }
    markDirty();
    renderAll();
    importDialog.close();
    setStatus(`Imported ${clean.length} chord events.`, 'ok');
  });

  // ---- Keyboard ----------------------------------------------------------------

  document.addEventListener('keydown', function(e) {
    const tag = document.activeElement.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (importDialog.open) return;

    if (e.code === 'Space' && !typing) {
      e.preventDefault();
      togglePlay();
    }
    if (e.code === 'Enter' && !typing) {
      e.preventDefault();
      tapChord();
    }
  });

  window.addEventListener('beforeunload', function(e) {
    if (dirty) e.preventDefault();
  });
});
