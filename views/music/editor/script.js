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
  const tabSync     = document.getElementById('tabSync');
  const syncTools   = document.getElementById('syncTools');
  const syncUndo    = document.getElementById('syncUndo');
  const syncClear   = document.getElementById('syncClear');
  const syncCount   = document.getElementById('syncCount');

  const deckRow = document.getElementById('deckRow');
  const zoomInBtn  = document.getElementById('zoomIn');
  const zoomOutBtn = document.getElementById('zoomOut');
  const zoomLevel  = document.getElementById('zoomLevel');

  const transportBar = document.getElementById('transportBar');
  const barPlayBtn   = document.getElementById('barPlay');
  const barBackBtn   = document.getElementById('barBack');
  const barFwdBtn    = document.getElementById('barFwd');

  const importDialog = document.getElementById('importDialog');
  const importText   = document.getElementById('importText');
  const importFile   = document.getElementById('importFile');
  const importApply  = document.getElementById('importApply');
  const importCancel = document.getElementById('importCancel');
  const importError  = document.getElementById('importError');

  let trackKey = null;
  let chords = [];          // [{ time, chord, line?, word? }] always sorted by time
  let words = [];           // word syncs [{ time, line, word }] sorted by time
  let selected = -1;        // index into chords
  let duration = 0;
  let isPlaying = false;
  let dirty = false;
  let audioReady = false;
  let lyricsMode = 'edit';  // edit | anchor | sync
  let syncHistory = [];     // stamped positions, newest last (for undo)
  let syncNext = null;      // { line, word } the Enter key stamps next

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
    hideScrollbar: false,
    normalize: true,
    // MediaElement keeps the pitch when the practice speed slows the tape
    backend: 'MediaElement'
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
  }

  function markClean() {
    dirty = false;
    saveBtn.innerHTML = '<i class="fas fa-floppy-disk"></i> Save';
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
    applyZoom(1); // reset the previous track's zoom before the new wave draws
    setRate(1);
    trackKey = key;
    chords = [];
    words = [];
    syncHistory = [];
    syncNext = null;
    selected = -1;
    audioReady = false;
    lyricsInput.value = '';
    markClean();
    saveBtn.disabled = true;
    importBtn.disabled = false;
    exportBtn.disabled = false;

    deckPanel.classList.remove('hidden');
    workPanel.classList.remove('hidden');
    transportBar.classList.remove('hidden');
    document.body.classList.add('has-transport');
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
          words = (data.words || []).slice().sort((a, b) => a.time - b.time);
          const bits = [`${chords.length} chord events`];
          if (words.length) bits.push(`${words.length} word syncs`);
          setStatus(`Loaded saved sheet (${bits.join(', ')}).`, 'ok');
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
    // keep the pitch when the practice speed slows the tape
    const media = wavesurfer.backend && wavesurfer.backend.media;
    if (media) {
      media.preservesPitch = true;
      media.webkitPreservesPitch = true;
    }
    wavesurfer.setPlaybackRate(playbackRate);
    renderMarkers();
  });

  wavesurfer.on('audioprocess', tick);
  wavesurfer.on('seek', tick);

  wavesurfer.on('finish', function() {
    isPlaying = false;
    updatePlayButtons();
    setRolling(false);
  });

  function setRolling(rolling) {
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
    const rows = [...chordList.querySelectorAll('.chord-row')];
    rows.forEach((row, i) => {
      row.classList.toggle('is-now', i === now);
    });

    // keep the playing chord in view; hands off while the pointer is in the
    // list so it doesn't fight a manual scroll
    if (now >= 0 && rows[now] && !chordList.matches(':hover')) {
      const row = rows[now];
      const top = row.offsetTop - (chordList.clientHeight - row.offsetHeight) / 2;
      chordList.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
  }

  function updatePlayButtons() {
    [playBtn, barPlayBtn].forEach(button => {
      const icon = button.querySelector('i');
      icon.classList.toggle('fa-play', !isPlaying);
      icon.classList.toggle('fa-pause', isPlaying);
    });
    barPlayBtn.classList.toggle('is-playing', isPlaying);
  }

  function togglePlay() {
    if (!audioReady) return;
    isPlaying = !isPlaying;
    wavesurfer.playPause();
    updatePlayButtons();
    setRolling(isPlaying);
  }

  playBtn.addEventListener('click', togglePlay);
  barPlayBtn.addEventListener('click', togglePlay);
  barBackBtn.addEventListener('click', () => { if (audioReady) wavesurfer.skip(-5); });
  barFwdBtn.addEventListener('click', () => { if (audioReady) wavesurfer.skip(5); });

  document.querySelectorAll('[data-skip]').forEach(button => {
    button.addEventListener('click', function() {
      if (audioReady) wavesurfer.skip(parseFloat(this.dataset.skip));
    });
  });

  // ---- Timeline zoom -------------------------------------------------------
  // Zooming multiplies the wave's px-per-second so chord flags that sit close
  // together on the timeline spread apart and become clickable. The wave then
  // scrolls horizontally and the marker rail mirrors that scroll.

  const ZOOM_MAX = 8;
  let zoomFactor = 1;

  function syncMarkerRail() {
    const wrapper = wavesurfer.drawer && wavesurfer.drawer.wrapper;
    if (!wrapper) return;
    markersEl.style.width = zoomFactor > 1 ? wrapper.scrollWidth + 'px' : '';
    markersEl.style.transform = zoomFactor > 1 ? `translateX(${-wrapper.scrollLeft}px)` : '';
  }

  function applyZoom(factor) {
    zoomFactor = factor;
    if (audioReady && duration) {
      if (factor === 1) {
        wavesurfer.zoom(0); // reset: fit the container, no scrolling
      } else {
        wavesurfer.zoom((wavesurfer.drawer.wrapper.clientWidth * factor) / duration);
      }
    }
    zoomLevel.textContent = `${factor}x`;
    zoomOutBtn.disabled = factor <= 1;
    zoomInBtn.disabled = factor >= ZOOM_MAX;
    syncMarkerRail();
  }

  zoomInBtn.addEventListener('click', () => applyZoom(Math.min(ZOOM_MAX, zoomFactor * 2)));
  zoomOutBtn.addEventListener('click', () => applyZoom(Math.max(1, zoomFactor / 2)));
  wavesurfer.drawer.wrapper.addEventListener('scroll', syncMarkerRail);

  let resizeTimer = null;
  window.addEventListener('resize', function() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(syncMarkerRail, 200);
  });

  // ---- Practice speed ------------------------------------------------------

  const rateButtons = [...document.querySelectorAll('.rate-group .btn-mini')];
  let playbackRate = 1;

  function setRate(rate) {
    playbackRate = rate;
    rateButtons.forEach(b => b.classList.toggle('is-active', parseFloat(b.dataset.rate) === rate));
    if (audioReady) wavesurfer.setPlaybackRate(rate);
  }

  rateButtons.forEach(button => {
    button.addEventListener('click', () => setRate(parseFloat(button.dataset.rate)));
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
    autoAnchorChord(event);
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

  tabEdit.addEventListener('click', () => setLyricsMode('edit'));
  tabAnchor.addEventListener('click', () => setLyricsMode('anchor'));
  tabSync.addEventListener('click', () => setLyricsMode('sync'));

  function setLyricsMode(mode) {
    lyricsMode = mode;
    tabEdit.classList.toggle('is-active', mode === 'edit');
    tabAnchor.classList.toggle('is-active', mode === 'anchor');
    tabSync.classList.toggle('is-active', mode === 'sync');
    lyricsInput.classList.toggle('hidden', mode !== 'edit');
    wordGrid.classList.toggle('hidden', mode === 'edit');
    syncTools.classList.toggle('hidden', mode !== 'sync');
    if (mode === 'sync') syncNext = wordAfterLastStamp();
    if (mode !== 'edit') renderWordGrid();
  }

  // lyrics tokenized exactly like the player does it (lines / whitespace)
  function lyricLines() {
    return lyricsInput.value.replace(/\r/g, '').split('\n').map(l => l.split(/\s+/).filter(Boolean));
  }

  function nextWordAfter(pos) {
    const lines = lyricLines();
    let l = pos ? pos.line : 0;
    let w = pos ? pos.word + 1 : 0;
    while (l < lines.length) {
      if (w < lines[l].length) return { line: l, word: w };
      l++;
      w = 0;
    }
    return null;
  }

  function wordAfterLastStamp() {
    let last = null;
    words.forEach(mark => {
      if (!last || mark.line > last.line || (mark.line === last.line && mark.word > last.word)) last = mark;
    });
    return last ? nextWordAfter(last) : nextWordAfter(null);
  }

  function renderWordGrid() {
    if (wordGrid.classList.contains('hidden')) return;
    wordGrid.innerHTML = '';
    syncCount.textContent = `${words.length} word sync${words.length === 1 ? '' : 's'}`;

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
    const wordTimes = {};
    words.forEach(mark => {
      wordTimes[`${mark.line}:${mark.word}`] = mark.time;
    });

    const syncMode = lyricsMode === 'sync';

    lines.forEach((line, lineIndex) => {
      const lineWords = line.split(/\s+/).filter(Boolean);
      if (!lineWords.length) {
        const gap = document.createElement('div');
        gap.className = 'wg-break';
        wordGrid.appendChild(gap);
        return;
      }

      const lineEl = document.createElement('div');
      lineEl.className = 'wg-line';

      lineWords.forEach((word, wordIndex) => {
        const key = `${lineIndex}:${wordIndex}`;
        const anchoredIndex = anchors[key];
        const syncTime = wordTimes[key];

        const button = document.createElement('button');
        button.className = 'wg-word';
        if (!syncMode) {
          if (anchoredIndex !== undefined) button.classList.add('is-anchored');
          if (anchoredIndex !== undefined && anchoredIndex === selected) button.classList.add('is-selected-anchor');
        } else {
          if (syncTime !== undefined) button.classList.add('is-synced');
          if (syncNext && syncNext.line === lineIndex && syncNext.word === wordIndex) {
            button.classList.add('is-next-sync');
          }
        }

        const label = document.createElement('span');
        label.className = 'wg-word__chord';
        label.textContent = syncMode
          ? (syncTime !== undefined ? formatPrecise(syncTime) : ' ')
          : (anchoredIndex !== undefined ? chords[anchoredIndex].chord : ' ');

        const text = document.createElement('span');
        text.textContent = word;

        button.appendChild(label);
        button.appendChild(text);
        button.addEventListener('click', () => {
          if (lyricsMode === 'sync') stampWord(lineIndex, wordIndex);
          else anchorWord(lineIndex, wordIndex, anchoredIndex);
        });
        lineEl.appendChild(button);
      });

      wordGrid.appendChild(lineEl);
    });

    // keep the word the next tap lands on centered, so a whole song can be
    // synced without ever touching the scrollbar
    if (syncMode) {
      const nextEl = wordGrid.querySelector('.wg-word.is-next-sync');
      if (nextEl) {
        const top = nextEl.offsetTop - (wordGrid.clientHeight - nextEl.offsetHeight) / 2;
        wordGrid.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
    }
  }

  // ---- Word sync stamping --------------------------------------------------

  function stampWord(lineIndex, wordIndex) {
    if (!audioReady) {
      setStatus('Wait for the audio to load before syncing words.', 'error');
      return;
    }
    const t = Math.round(wavesurfer.getCurrentTime() * 100) / 100;
    const existing = words.find(w => w.line === lineIndex && w.word === wordIndex);
    if (existing && existing.time === t) {
      // second click without moving the playhead removes the stamp
      words.splice(words.indexOf(existing), 1);
      syncHistory = syncHistory.filter(h => !(h.line === lineIndex && h.word === wordIndex));
      syncNext = { line: lineIndex, word: wordIndex };
    } else {
      if (existing) existing.time = t;
      else words.push({ time: t, line: lineIndex, word: wordIndex });
      syncHistory.push({ line: lineIndex, word: wordIndex });
      syncNext = nextWordAfter({ line: lineIndex, word: wordIndex });
    }
    words.sort((a, b) => a.time - b.time);
    autoAnchorAll();
    markDirty();
    renderChordList();
    renderWordGrid();
  }

  syncUndo.addEventListener('click', function() {
    const last = syncHistory.pop();
    if (!last) return;
    const index = words.findIndex(w => w.line === last.line && w.word === last.word);
    if (index >= 0) words.splice(index, 1);
    syncNext = { line: last.line, word: last.word };
    markDirty();
    renderWordGrid();
  });

  syncClear.addEventListener('click', function() {
    if (!words.length) return;
    if (!confirm(`Remove all ${words.length} word syncs?`)) return;
    words = [];
    syncHistory = [];
    syncNext = nextWordAfter(null);
    markDirty();
    renderWordGrid();
  });

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
      assignAnchor(event, lineIndex, wordIndex);
    }
    markDirty();
    renderChordList();
    renderWordGrid();
  }

  // ---- Auto-anchor from word sync ------------------------------------------
  // Once words are time-stamped (Sync tab), a chord's own timestamp already
  // tells us which word is playing right then, so a freshly tapped chord can
  // bind itself straight to that word instead of requiring a manual Anchor
  // click. Binding only happens within roughly one word's worth of time of
  // the match, so a chord tapped during a real instrumental stretch is left
  // unanchored (and still renders as an instrumental run) instead of
  // snapping to a stale word from the last line that was sung.

  function averageWordGap() {
    if (words.length < 2) return 2;
    let total = 0;
    for (let i = 1; i < words.length; i++) total += words[i].time - words[i - 1].time;
    return total / (words.length - 1);
  }

  function assignAnchor(event, line, word) {
    // a word holds at most one chord; steal it from whoever else has it
    chords.forEach(other => {
      if (other !== event && other.line === line && other.word === word) {
        delete other.line;
        delete other.word;
      }
    });
    event.line = line;
    event.word = word;
  }

  function autoAnchorChord(event) {
    if (!words.length || Number.isInteger(event.line)) return;
    let match = null;
    for (let i = 0; i < words.length; i++) {
      if (words[i].time <= event.time) match = words[i]; else break;
    }
    if (!match) return; // the chord lands before any synced word
    const threshold = Math.max(averageWordGap() * 2.5, 1.5);
    if (event.time - match.time > threshold) return; // too far: probably instrumental
    assignAnchor(event, match.line, match.word);
  }

  function autoAnchorAll() {
    chords.forEach(autoAnchorChord);
  }

  function renderAll() {
    renderChordList();
    renderMarkers();
    renderWordGrid();
    renderSuggestions();
  }

  // ---- Next-chord suggestions (local theory engine) -----------------------
  // Hooktheory-style "what usually comes next": infer the key from the chords
  // used so far, map the last chord to a scale degree, then look up common
  // follow-up degrees. No network, no account needed.

  const suggestBlock = document.getElementById('suggestBlock');
  const suggestRow   = document.getElementById('suggestRow');
  const keyGuess     = document.getElementById('keyGuess');
  // chord names currently shown in suggestRow, in display order; the keydown
  // handler taps currentSuggestions[digit - 1] when the digit is 1-4
  let currentSuggestions = [];

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
    currentSuggestions = [];
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
    currentSuggestions = [];
    offsets.slice(0, 4).forEach(offset => {
      const quality = DIATONIC[key.mode][offset];
      if (quality === 'dim') return; // rarely what a guitarist reaches for
      const name = NOTE_NAMES[(key.tonic + offset) % 12] + (quality === 'm' ? 'm' : '');
      const keyNum = currentSuggestions.length + 1;
      currentSuggestions.push(name);
      const chip = document.createElement('button');
      chip.className = 'chip chip--suggest';
      chip.innerHTML = `<span class="chip__key">${keyNum}</span>${name} <span class="chip__degree">${roman[offset]}</span>`;
      chip.title = `Press ${keyNum} or click to tap ${name} at the playhead`;
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
      body: JSON.stringify({ track_key: trackKey, lyrics: lyricsInput.value, chords: chords, words: words })
    })
      .then(r => r.json().then(body => ({ ok: r.ok, body })))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || 'Save failed');
        markClean();
        const savedWords = (body.words || []).length;
        setStatus(`Saved (${body.chords.length} chord events${savedWords ? `, ${savedWords} word syncs` : ''}).`, 'ok');
      })
      .catch(error => {
        saveBtn.disabled = false;
        setStatus('Save failed: ' + error.message, 'error');
      });
  });

  exportBtn.addEventListener('click', function() {
    if (!trackKey) return;
    const payload = { track_key: trackKey, lyrics: lyricsInput.value, chords: chords, words: words };
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
    let importedWords = 0;
    if (!Array.isArray(parsed) && Array.isArray(parsed.words)) {
      words = parsed.words
        .filter(w => w && typeof w.time === 'number' && w.time >= 0
          && Number.isInteger(w.line) && w.line >= 0
          && Number.isInteger(w.word) && w.word >= 0)
        .map(w => ({ time: Math.round(w.time * 100) / 100, line: w.line, word: w.word }))
        .sort((a, b) => a.time - b.time);
      syncHistory = [];
      syncNext = wordAfterLastStamp();
      importedWords = words.length;
      autoAnchorAll();
    }
    markDirty();
    renderAll();
    importDialog.close();
    setStatus(`Imported ${clean.length} chord events${importedWords ? ` and ${importedWords} word syncs` : ''}.`, 'ok');
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
      // in Sync mode Enter stamps the next word instead of tapping a chord
      if (lyricsMode === 'sync' && trackKey) {
        if (syncNext) stampWord(syncNext.line, syncNext.word);
      } else {
        tapChord();
      }
    }
    // 1-4 tap the current "next chord ideas" suggestion when it's shown;
    // otherwise number keys tap the quick chord chips (1-9, 0 = tenth chip)
    if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && /^Digit\d$/.test(e.code) && trackKey) {
      const digit = Number(e.code.slice(5));
      const suggested = digit >= 1 && digit <= 4 && !suggestBlock.classList.contains('hidden')
        ? currentSuggestions[digit - 1]
        : null;
      const chip = suggested || QUICK_CHORDS[digit === 0 ? 9 : digit - 1];
      if (chip) {
        e.preventDefault();
        chordInput.value = chip;
        tapChord(chip);
      }
    }
  });

  window.addEventListener('beforeunload', function(e) {
    if (dirty) e.preventDefault();
  });
});
