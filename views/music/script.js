document.addEventListener('DOMContentLoaded', function() {
  const SYNC_API = '../../app/controllers/music-controller.php';
  const TABS_API = '../../app/proxys/tabs-proxy.php';
  const GAP_CHORDS = ['', 'N.C.', 'NC', '-'];

  // Length filter buckets, in seconds
  const DURATION_BUCKETS = {
    short: d => d < 180,
    mid: d => d >= 180 && d <= 270,
    long: d => d > 270
  };

  // ---- DOM ----------------------------------------------------------------
  const deckPanel = document.getElementById('deckPanel');
  const deckSide = document.getElementById('deckSide');
  const deckTitle = document.getElementById('deckTitle');
  const deckArtist = document.getElementById('deckArtist');
  const deckTime = document.getElementById('deckTime');
  const deckSpinner = document.getElementById('deckSpinner');
  const playerControls = document.getElementById('playerControls');
  const btnPlay = document.getElementById('btnPlay');
  const btnTab = document.getElementById('btnTab');
  const volumeSlider = document.getElementById('volumeSlider');
  const rateGroup = document.getElementById('rateGroup');
  const currentTimeEl = document.getElementById('currentTime');
  const totalTimeEl = document.getElementById('totalTime');
  const progressBar = document.getElementById('progressBar');
  const progressEl = document.getElementById('progress');
  const chordsheetEl = document.getElementById('chordsheet');
  const searchInput = document.getElementById('searchInput');
  const resultsEl = document.getElementById('results');
  const finderCount = document.getElementById('finderCount');
  const finderEmpty = document.getElementById('finderEmpty');
  const artistDd = document.getElementById('artistDd');
  const artistToggle = document.getElementById('artistToggle');
  const artistToggleLabel = document.getElementById('artistToggleLabel');
  const artistMenu = document.getElementById('artistMenu');

  // ---- State ----------------------------------------------------------------
  let allTracks = []; // flat list: {key, src, category, title, artist, name, duration}
  const filters = { query: '', category: '', duration: '', artist: '' };

  // The one deck. Mirrors the old per-track player object so the chordsheet
  // rendering + sweep logic below carries over unchanged.
  const deck = {
    wavesurfer: null,
    track: null,        // the selected entry from allTracks
    isLoaded: false,
    isPlaying: false,
    isLoading: false,
    rate: 1,            // practice speed, kept across track switches
    sync: null          // rendered chord/lyrics refs once loaded
  };

  const syncCache = {}; // track key -> sheet data | 'empty' (errors are not cached)
  const tabCache = {};  // track key -> {found, url, ...} | 'error'

  // Which tracks have a saved chord sheet. Knowing this up front lets the
  // deck skip the per-track request (and its console-visible 404) for tracks
  // without one. null = list unavailable, fall back to per-track fetches.
  let syncIndex = null;
  fetch(`${SYNC_API}?resource=sync`)
    .then(response => (response.ok ? response.json() : Promise.reject()))
    .then(rows => {
      syncIndex = new Set(rows.map(row => row.track_key));
    })
    .catch(() => {
      syncIndex = null;
    });

  fetch('../../assets/music/tracks.json')
    .then(response => response.json())
    .then(data => {
      ['acoustic', 'electric'].forEach(category => {
        (data[category] || []).forEach(track => {
          allTracks.push({
            key: `${category}/${track.file}`,
            src: `../../assets/music/${category}/${track.file}`,
            category: category,
            title: track.title || track.name,
            artist: track.artist || '',
            name: track.name,
            duration: track.duration || 0
          });
        });
      });
      allTracks.sort((a, b) => a.title.localeCompare(b.title));
      buildArtistMenu();
      applyFilters();
    })
    .catch(error => console.error('Error loading tracks:', error));

  // ---- Finder: search + filters --------------------------------------------

  function normalize(text) {
    return (text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function filteredTracks() {
    const query = normalize(filters.query).trim();
    return allTracks.filter(track => {
      if (filters.category && track.category !== filters.category) return false;
      if (filters.artist && track.artist !== filters.artist) return false;
      if (filters.duration && !DURATION_BUCKETS[filters.duration](track.duration)) return false;
      if (query && !normalize(`${track.title} ${track.artist} ${track.name}`).includes(query)) return false;
      return true;
    });
  }

  function applyFilters() {
    const matches = filteredTracks();
    resultsEl.innerHTML = '';

    matches.forEach(track => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tape';
      row.dataset.key = track.key;

      const side = document.createElement('span');
      side.className = `tape__side tape__side--${track.category}`;
      side.textContent = track.category === 'acoustic' ? 'AC' : 'EL';
      side.title = track.category;

      const title = document.createElement('span');
      title.className = 'tape__title';
      title.textContent = track.title;

      const artist = document.createElement('span');
      artist.className = 'tape__artist';
      artist.textContent = track.artist;

      const time = document.createElement('span');
      time.className = 'tape__time';
      time.textContent = formatTime(track.duration);

      const eq = document.createElement('span');
      eq.className = 'tape__eq';
      eq.innerHTML = '<span></span><span></span><span></span>';

      row.appendChild(side);
      row.appendChild(title);
      row.appendChild(artist);
      row.appendChild(time);
      row.appendChild(eq);
      resultsEl.appendChild(row);
    });

    finderCount.textContent = `${matches.length} / ${allTracks.length} tapes`;
    finderEmpty.classList.toggle('hidden', matches.length > 0);
    refreshRowStates();
  }

  function refreshRowStates() {
    resultsEl.querySelectorAll('.tape').forEach(row => {
      const isCurrent = !!deck.track && row.dataset.key === deck.track.key;
      row.classList.toggle('is-current', isCurrent);
      row.classList.toggle('is-playing', isCurrent && deck.isPlaying);
    });
  }

  resultsEl.addEventListener('click', function(e) {
    const row = e.target.closest('.tape');
    if (!row) return;
    const track = allTracks.find(t => t.key === row.dataset.key);
    if (track) selectTrack(track);
  });

  searchInput.addEventListener('input', function() {
    filters.query = this.value;
    applyFilters();
  });

  function bindChipRow(container, filterName) {
    container.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', function() {
        filters[filterName] = this.dataset.value;
        container.querySelectorAll('.filter-chip').forEach(c => {
          c.classList.toggle('is-active', c === this);
        });
        applyFilters();
      });
    });
  }
  bindChipRow(document.getElementById('filterCategory'), 'category');
  bindChipRow(document.getElementById('filterDuration'), 'duration');

  // ---- Artist dropdown ------------------------------------------------------

  function buildArtistMenu() {
    const counts = {};
    allTracks.forEach(track => {
      if (track.artist) counts[track.artist] = (counts[track.artist] || 0) + 1;
    });
    const artists = Object.keys(counts).sort((a, b) => a.localeCompare(b));

    artistMenu.innerHTML = '';
    const addItem = (value, label, count) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'artist-dd__item' + (filters.artist === value ? ' is-active' : '');
      item.dataset.value = value;
      item.setAttribute('role', 'option');
      item.innerHTML = `<span>${label}</span><span class="artist-dd__count">${count}</span>`;
      item.addEventListener('click', function() {
        filters.artist = this.dataset.value;
        artistToggleLabel.textContent = this.dataset.value || 'All artists';
        artistToggle.classList.toggle('is-filtering', !!this.dataset.value);
        artistMenu.querySelectorAll('.artist-dd__item').forEach(i => {
          i.classList.toggle('is-active', i === this);
        });
        closeArtistMenu();
        applyFilters();
      });
      artistMenu.appendChild(item);
    };

    addItem('', 'All artists', allTracks.length);
    artists.forEach(artist => addItem(artist, artist, counts[artist]));
  }

  function closeArtistMenu() {
    artistMenu.classList.add('hidden');
    artistToggle.setAttribute('aria-expanded', 'false');
  }

  artistToggle.addEventListener('click', function() {
    const open = artistMenu.classList.toggle('hidden');
    artistToggle.setAttribute('aria-expanded', String(!open));
  });

  document.addEventListener('click', function(e) {
    if (!artistDd.contains(e.target)) closeArtistMenu();
  });

  // ---- The deck -------------------------------------------------------------

  // MediaElement backend so the practice speed control keeps the pitch
  // (WebAudio rate would detune the song).
  deck.wavesurfer = WaveSurfer.create({
    container: document.getElementById('waveform'),
    backend: 'MediaElement',
    waveColor: 'rgba(28, 26, 23, 0.22)',
    progressColor: '#d4451f',
    cursorColor: '#1c1a17',
    barWidth: 2,
    barRadius: 2,
    cursorWidth: 0,
    height: 90,
    responsive: true,
    hideScrollbar: true,
    normalize: true
  });

  // Practice speed: 50-100% playback rate
  [0.5, 0.75, 0.9, 1].forEach(rate => {
    const button = document.createElement('button');
    button.className = 'btn-mini' + (rate === 1 ? ' is-active' : '');
    button.dataset.rate = String(rate);
    button.textContent = `${rate * 100}%`;
    button.title = `Play at ${rate * 100}% speed`;
    button.addEventListener('click', function() {
      deck.rate = parseFloat(this.dataset.rate);
      if (deck.isLoaded) deck.wavesurfer.setPlaybackRate(deck.rate);
      rateGroup.querySelectorAll('.btn-mini').forEach(b => {
        b.classList.toggle('is-active', b === this);
      });
    });
    rateGroup.appendChild(button);
  });

  function setPlayingUI(playing) {
    deck.isPlaying = playing;
    btnPlay.querySelector('i').className = playing ? 'fas fa-pause' : 'fas fa-play';
    deckPanel.classList.toggle('is-playing', playing);
    if (!playing) {
      wakeLock?.release();
      wakeLock = null;
    }
    refreshRowStates();
  }

  function selectTrack(track) {
    if (deck.track && deck.track.key === track.key) {
      scrollToDeck();
      return;
    }

    if (deck.isPlaying) {
      deck.wavesurfer.pause();
      setPlayingUI(false);
    }

    deck.track = track;
    deck.isLoaded = false;
    deck.isLoading = true;
    deck.sync = null;

    deckSide.textContent = track.category === 'acoustic' ? 'AC' : 'EL';
    deckSide.className = `deck-head__side deck-head__side--${track.category}`;
    deckTitle.textContent = track.title;
    deckArtist.textContent = track.artist;
    deckTime.textContent = formatTime(track.duration);
    currentTimeEl.textContent = '0:00';
    totalTimeEl.textContent = formatTime(track.duration);
    progressEl.style.width = '0%';
    btnTab.classList.add('hidden');

    chordsheetEl.classList.add('hidden');
    chordsheetEl.classList.remove('chordsheet--empty');
    chordsheetEl.innerHTML = '';

    deckPanel.classList.remove('hidden');
    deckSpinner.classList.remove('hidden');
    playerControls.classList.add('loading');

    loadChordSheet(track);
    loadTabLink(track);

    console.log(`Loading track from ${track.src}`);
    deck.wavesurfer.load(track.src);

    refreshRowStates();
    scrollToDeck();
  }

  function scrollToDeck() {
    const top = deckPanel.getBoundingClientRect().top + window.scrollY - 96;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  btnPlay.addEventListener('click', function() {
    if (deck.isLoading || !deck.track) return;
    if (deck.isPlaying) {
      deck.wavesurfer.pause();
      setPlayingUI(false);
    } else {
      deck.wavesurfer.play();
      setPlayingUI(true);
      requestWakeLock();
    }
  });

  volumeSlider.addEventListener('input', function() {
    deck.wavesurfer.setVolume(parseFloat(this.value) / 100);
  });

  progressBar.addEventListener('click', function(e) {
    if (deck.isLoading || !deck.isLoaded) return;
    const rect = this.getBoundingClientRect();
    deck.wavesurfer.seekTo((e.clientX - rect.left) / rect.width);
  });

  // ---- Wavesurfer events ------------------------------------------------------

  deck.wavesurfer.on('loading', function(percent) {
    // With the MediaElement backend, 'loading' tracks the separate waveform
    // download, which keeps firing after 'ready' (the media is playable long
    // before the full file is fetched for drawing). Once ready, never fall
    // back into the loading state.
    if (deck.isLoaded) return;
    deckSpinner.classList.remove('hidden');
    deck.isLoading = true;
    playerControls.classList.add('loading');
  });

  deck.wavesurfer.on('ready', function() {
    const duration = deck.wavesurfer.getDuration();
    totalTimeEl.textContent = formatTime(duration);
    deckTime.textContent = formatTime(duration);
    deck.isLoaded = true;
    deck.isLoading = false;
    deckSpinner.classList.add('hidden');

    // keep the pitch when slowed down; apply a rate picked while loading
    const media = deck.wavesurfer.backend && deck.wavesurfer.backend.media;
    if (media) {
      media.preservesPitch = true;
      media.webkitPreservesPitch = true;
    }
    deck.wavesurfer.setPlaybackRate(deck.rate);

    playerControls.classList.remove('loading');
  });

  deck.wavesurfer.on('audioprocess', function() {
    const currentTime = deck.wavesurfer.getCurrentTime();
    currentTimeEl.textContent = formatTime(currentTime);
    progressEl.style.width = `${(currentTime / deck.wavesurfer.getDuration()) * 100}%`;
    updateChordSync(currentTime);
  });

  deck.wavesurfer.on('seek', function() {
    updateChordSync(deck.wavesurfer.getCurrentTime());
  });

  deck.wavesurfer.on('finish', function() {
    setPlayingUI(false);
    updateChordSync(0);
  });

  deck.wavesurfer.on('error', function(err) {
    console.error('WaveSurfer error:', err);
    // a waveform decode hiccup after the media is already playable isn't
    // fatal: keep the controls, just miss the wave drawing
    if (deck.isLoaded) return;
    deckSpinner.classList.add('hidden');
    deck.isLoading = false;
    playerControls.classList.remove('loading');
    alert('Error loading audio: ' + err);
  });

  // ---- Keyboard controls ------------------------------------------------------

  document.addEventListener('keydown', function(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';

    // "/" jumps to the search box from anywhere
    if (e.key === '/' && !typing) {
      e.preventDefault();
      searchInput.focus();
      return;
    }
    if (typing) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }

    if (!deck.track || deck.isLoading) return;

    if (e.code === 'Space') {
      e.preventDefault();
      btnPlay.click();
    }

    if (e.code === 'ArrowLeft' && deck.isLoaded) {
      const t = deck.wavesurfer.getCurrentTime();
      deck.wavesurfer.seekTo(Math.max(0, t - 5) / deck.wavesurfer.getDuration());
    }

    if (e.code === 'ArrowRight' && deck.isLoaded) {
      const t = deck.wavesurfer.getCurrentTime();
      deck.wavesurfer.seekTo(Math.min(deck.wavesurfer.getDuration(), t + 5) / deck.wavesurfer.getDuration());
    }

    if (e.code === 'ArrowUp' && deck.isLoaded) {
      e.preventDefault();
      volumeSlider.value = Math.min(100, parseInt(volumeSlider.value) + 5);
      deck.wavesurfer.setVolume(volumeSlider.value / 100);
    }

    if (e.code === 'ArrowDown' && deck.isLoaded) {
      e.preventDefault();
      volumeSlider.value = Math.max(0, parseInt(volumeSlider.value) - 5);
      deck.wavesurfer.setVolume(volumeSlider.value / 100);
    }
  });

  let wakeLock = null;

  async function requestWakeLock() {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (err) {
      console.error(`${err.name}, ${err.message}`);
    }
  }

  // ---- Songsterr tab link -----------------------------------------------------

  function showTabLink(track, data) {
    if (!data.found || !deck.track || deck.track.key !== track.key) return;
    btnTab.href = data.url;
    btnTab.title = `Guitar tab on Songsterr: ${data.artist} - ${data.title}`;
    btnTab.classList.remove('hidden');
  }

  function loadTabLink(track) {
    const cached = tabCache[track.key];
    if (cached && cached !== 'error') {
      showTabLink(track, cached);
      return;
    }
    if (cached === 'error') return;

    const query = track.name.replace(/\s+-\s+/g, ' ');
    fetch(`${TABS_API}?q=${encodeURIComponent(query)}`)
      .then(response => (response.ok ? response.json() : Promise.reject()))
      .then(data => {
        tabCache[track.key] = data;
        showTabLink(track, data);
      })
      .catch(() => {
        tabCache[track.key] = 'error'; // quietly: a missing tab button is fine
      });
  }

  // ---- Chords + lyrics songbook -----------------------------------------

  function isGapChord(name) {
    return GAP_CHORDS.includes((name || '').trim());
  }

  function loadChordSheet(track) {
    const cached = syncCache[track.key];
    if (cached === 'empty') {
      renderChordSheetEmpty(track);
      return;
    }
    if (cached) {
      renderChordSheet(chordsheetEl, cached);
      return;
    }

    if (syncIndex && !syncIndex.has(track.key)) {
      syncCache[track.key] = 'empty';
      renderChordSheetEmpty(track);
      return;
    }

    fetch(`${SYNC_API}?resource=sync&track=${encodeURIComponent(track.key)}`)
      .then(response => {
        if (response.status === 404) {
          syncCache[track.key] = 'empty';
          if (deck.track && deck.track.key === track.key) renderChordSheetEmpty(track);
          return null;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(data => {
        if (!data) return;
        syncCache[track.key] = data;
        if (deck.track && deck.track.key === track.key) renderChordSheet(chordsheetEl, data);
      })
      .catch(error => {
        console.error(`Error loading chords for ${track.key}:`, error);
        if (!deck.track || deck.track.key !== track.key) return;
        chordsheetEl.classList.remove('hidden');
        chordsheetEl.innerHTML = '';
        chordsheetEl.classList.add('chordsheet--empty');
        const msg = document.createElement('p');
        msg.className = 'chordsheet__message';
        msg.textContent = 'Chords and lyrics are unavailable right now (backend offline).';
        chordsheetEl.appendChild(msg);
      });
  }

  function renderChordSheetEmpty(track) {
    chordsheetEl.classList.remove('hidden');
    chordsheetEl.classList.add('chordsheet--empty');
    chordsheetEl.innerHTML = '';

    const msg = document.createElement('p');
    msg.className = 'chordsheet__message';
    msg.textContent = 'No chords or lyrics for this track yet.';

    const link = document.createElement('a');
    link.className = 'chordsheet__link';
    link.href = `editor/?track=${encodeURIComponent(track.key)}`;
    link.innerHTML = '<i class="fas fa-pen-nib"></i> Add them in the editor';

    chordsheetEl.appendChild(msg);
    chordsheetEl.appendChild(link);
  }

  function renderChordSheet(sheet, data) {
    sheet.classList.remove('hidden', 'chordsheet--empty');
    sheet.innerHTML = '';

    const events = (data.chords || []).slice().sort((a, b) => a.time - b.time);

    // Header: live chord badge + what's coming next
    const head = document.createElement('div');
    head.className = 'chordsheet__head';

    const label = document.createElement('span');
    label.className = 'chordsheet__label';
    label.textContent = 'Chord';

    const current = document.createElement('span');
    current.className = 'chordsheet__current';
    current.textContent = '—';
    current.setAttribute('data-chord-anchor', '');
    current.title = 'Show the chord diagram';
    current.addEventListener('click', function() {
      if (this.textContent !== '—') ChordCard.show(this.textContent, this);
    });

    const next = document.createElement('span');
    next.className = 'chordsheet__next';
    next.textContent = events.length ? `next: ${events[0].chord}` : '';
    next.setAttribute('data-chord-anchor', '');
    next.title = 'Show the chord diagram';
    next.addEventListener('click', function() {
      const name = this.textContent.replace(/^next:\s*/, '');
      if (name && !isGapChord(name)) ChordCard.show(name, this);
    });

    head.appendChild(label);
    head.appendChild(current);
    head.appendChild(next);
    sheet.appendChild(head);

    // Body: lyrics with anchored chords above their word
    const body = document.createElement('div');
    body.className = 'chordsheet__body';

    const anchors = {};
    events.forEach((event, index) => {
      if (Number.isInteger(event.line) && Number.isInteger(event.word)) {
        anchors[`${event.line}:${event.word}`] = index;
      }
    });

    const eventEls = events.map(() => null);
    const eventFlat = events.map(() => -1); // event index -> flat word index
    const flatWords = [];                   // every rendered word, reading order
    const flatByPos = {};                   // "line:word" -> flat word index
    const lines = (data.lyrics || '').replace(/\r/g, '').split('\n');

    lines.forEach((line, lineIndex) => {
      const words = line.split(/\s+/).filter(Boolean);
      if (!words.length) {
        const gap = document.createElement('div');
        gap.className = 'cs-break';
        body.appendChild(gap);
        return;
      }

      const lineEl = document.createElement('div');
      lineEl.className = 'cs-line';

      words.forEach((word, wordIndex) => {
        const wordEl = document.createElement('span');
        wordEl.className = 'cs-word';

        const chordEl = document.createElement('span');
        chordEl.className = 'cs-chord';
        const eventIndex = anchors[`${lineIndex}:${wordIndex}`];
        if (eventIndex !== undefined && !isGapChord(events[eventIndex].chord)) {
          chordEl.textContent = events[eventIndex].chord;
          chordEl.setAttribute('data-chord-anchor', '');
          chordEl.title = 'Show the chord diagram';
          chordEl.addEventListener('click', function() {
            ChordCard.show(this.textContent, this);
          });
          eventEls[eventIndex] = { chordEl, lineEl };
          eventFlat[eventIndex] = flatWords.length;
        } else {
          chordEl.classList.add('cs-chord--blank');
          chordEl.textContent = ' ';
        }

        const textEl = document.createElement('span');
        textEl.className = 'cs-word-text';
        textEl.textContent = word;

        wordEl.appendChild(chordEl);
        wordEl.appendChild(textEl);
        lineEl.appendChild(wordEl);

        flatByPos[`${lineIndex}:${wordIndex}`] = flatWords.length;
        flatWords.push({ wordEl, lineEl });
      });

      body.appendChild(lineEl);
    });

    // Chords not bound to any word: treat the run as an instrumental passage
    // and render it as its own row, placed after the last sung line before it.
    let insertRef = null;
    let runRow = null;
    let instrumentalCount = 0;
    events.forEach((event, index) => {
      if (eventEls[index]) {
        // anchored: instrumental runs that follow belong after this line
        insertRef = eventEls[index].lineEl;
        runRow = null;
        return;
      }
      if (isGapChord(event.chord)) {
        runRow = null;
        return;
      }
      if (!runRow) {
        runRow = document.createElement('div');
        runRow.className = 'cs-instrumental';
        const tag = document.createElement('span');
        tag.className = 'cs-instrumental__tag';
        tag.innerHTML = '<i class="fas fa-music"></i> instrumental';
        runRow.appendChild(tag);
        if (insertRef) insertRef.after(runRow);
        else body.prepend(runRow);
        insertRef = runRow;
      }
      const chip = document.createElement('span');
      chip.className = 'cs-chord cs-chord--inst';
      chip.textContent = event.chord;
      chip.setAttribute('data-chord-anchor', '');
      chip.title = 'Show the chord diagram';
      chip.addEventListener('click', function() {
        ChordCard.show(this.textContent, this);
      });
      runRow.appendChild(chip);
      eventEls[index] = { chordEl: chip, lineEl: runRow };
      instrumentalCount++;
    });

    if (!flatWords.length && !instrumentalCount) {
      const msg = document.createElement('p');
      msg.className = 'chordsheet__message';
      msg.textContent = 'Chords are synced, but no lyrics were added for this track.';
      body.appendChild(msg);
    }

    // Sweep anchors: the timestamped word positions the highlight moves
    // between. When the editor's word-for-word syncs exist they are the
    // ground truth and drive the highlight alone (chords still render above
    // the words and feed the chord badge, but their times no longer steer
    // the sweep). Only a track without word syncs falls back to the anchored
    // chord events, interpolating between them karaoke style.
    const wordAnchors = [];
    (data.words || []).forEach(mark => {
      if (typeof mark.time !== 'number') return;
      const flat = flatByPos[`${mark.line}:${mark.word}`];
      if (flat !== undefined) wordAnchors.push({ time: mark.time, flat: flat });
    });
    const chordAnchors = [];
    events.forEach((event, i) => {
      if (eventFlat[i] >= 0) chordAnchors.push({ time: event.time, flat: eventFlat[i] });
    });
    const sweepAnchors = wordAnchors.length ? wordAnchors : chordAnchors;
    sweepAnchors.sort((a, b) => a.time - b.time || a.flat - b.flat);

    // times where singing stops. With word sync as the ground truth, only an
    // explicit N.C.-style gap chord counts: treating every merely-unanchored
    // chord as a gap (the old behavior) meant a track that had been word-synced
    // but never chord-anchored would have its highlight cut out almost
    // everywhere, since none of its chords carried a word anchor yet. Without
    // word sync (the chord-anchor-only fallback below) an unanchored chord is
    // still read as an instrumental interruption, same as before.
    const wordSyncDriven = wordAnchors.length > 0;
    const gapTimes = events
      .filter((e, i) => isGapChord(e.chord) || (!wordSyncDriven && eventFlat[i] < 0))
      .map(e => e.time);
    const nextGapAfter = (t) => gapTimes.find(g => g > t);

    // An anchor with no forward-moving successor (end of a line before an
    // instrumental, a gap, or the end of the song) sweeps out the rest of
    // its own line: towards the interrupting event's time when one exists,
    // or at the song's average words-per-second pace for the final anchor.
    // releases[k] marks when anchor k's highlight must be dropped.
    const segments = [];
    const releases = {};
    const lastWordOfLine = (flat) => {
      let j = flat;
      while (j + 1 < flatWords.length && flatWords[j + 1].lineEl === flatWords[flat].lineEl) j++;
      return j;
    };
    let paceTime = 0;
    let paceWords = 0;
    sweepAnchors.forEach((anchor, k) => {
      const next = sweepAnchors[k + 1];
      const gapT = nextGapAfter(anchor.time);
      if (next && next.flat > anchor.flat && next.time > anchor.time
          && (gapT === undefined || gapT >= next.time)) {
        segments.push({ start: anchor.time, end: next.time, from: anchor.flat, to: next.flat });
        paceTime += next.time - anchor.time;
        paceWords += next.flat - anchor.flat;
      } else if (gapT !== undefined && gapT > anchor.time && (!next || gapT < next.time)) {
        segments.push({ start: anchor.time, end: gapT, from: anchor.flat, to: lastWordOfLine(anchor.flat) + 1 });
        releases[k] = gapT;
      } else if (!next) {
        const to = lastWordOfLine(anchor.flat) + 1;
        const pace = paceWords > 0 ? paceTime / paceWords : 0.6;
        const end = anchor.time + Math.max(1, (to - anchor.flat) * pace);
        segments.push({ start: anchor.time, end: end, from: anchor.flat, to: to });
        releases[k] = end;
      }
      // otherwise the next anchor rewinds to an earlier word (a repeat) with
      // no gap in between: no sweep, the highlight parks until it takes over
    });

    sheet.appendChild(body);

    deck.sync = {
      events: events,
      eventEls: eventEls,
      eventFlat: eventFlat,
      flatWords: flatWords,
      segments: segments,
      anchors: sweepAnchors,
      releases: releases,
      currentEl: current,
      nextEl: next,
      bodyEl: body,
      activeIndex: -1,
      sweepIndex: -1,
      lastLineEl: null
    };
  }

  // Last event whose time <= t (binary search); -1 if before the first chord
  function findActiveChord(events, t) {
    let lo = 0, hi = events.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid].time <= t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  function updateChordSync(currentTime) {
    const sync = deck.sync;
    if (!sync) return;

    // Chord badge + active-chord highlight only apply when chords exist. A
    // word-synced track with zero chords still needs its karaoke sweep, so the
    // sweep below runs unconditionally (this block used to guard the whole
    // function, which killed the highlight on lyrics-only tracks).
    if (sync.events.length) {
      const index = findActiveChord(sync.events, currentTime);
      if (index !== sync.activeIndex) {
        if (sync.activeIndex >= 0 && sync.eventEls[sync.activeIndex]) {
          sync.eventEls[sync.activeIndex].chordEl.classList.remove('is-active');
        }
        sync.activeIndex = index;

        const event = index >= 0 ? sync.events[index] : null;
        const nextEvent = sync.events[index + 1] || null;

        // a gap (no chord assigned, or an explicit N.C.) reads as a rest
        sync.currentEl.textContent = event && !isGapChord(event.chord) ? event.chord : '—';
        sync.nextEl.textContent = nextEvent ? `next: ${nextEvent.chord}` : '';

        if (event && sync.eventEls[index]) {
          sync.eventEls[index].chordEl.classList.add('is-active');
          // instrumental rows have no words to sweep through; scroll to them here
          if (sync.eventFlat[index] < 0) {
            scrollToLine(sync, sync.eventEls[index].lineEl);
          }
        }
      }
    }

    updateWordSweep(sync, currentTime);
  }

  // keep the active line centered in the panel without scrolling the page
  function scrollToLine(sync, lineEl) {
    if (!lineEl || lineEl === sync.lastLineEl) return;
    sync.lastLineEl = lineEl;
    const top = lineEl.offsetTop - (sync.bodyEl.clientHeight - lineEl.offsetHeight) / 2;
    sync.bodyEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  // Karaoke-style interpolation: only chord checkpoints carry timestamps, so
  // between two anchored chords the highlighted word advances linearly.
  function updateWordSweep(sync, t) {
    let target = -1;

    for (let i = 0; i < sync.segments.length; i++) {
      const seg = sync.segments[i];
      if (t >= seg.start && t < seg.end) {
        const progress = (t - seg.start) / (seg.end - seg.start);
        target = seg.from + Math.floor(progress * (seg.to - seg.from));
        break;
      }
    }
    if (target === -1 && sync.anchors.length) {
      // not inside a sweep segment: park on the latest anchor's word, but
      // only until its release time passes (then the highlight drops)
      let lo = 0, hi = sync.anchors.length - 1, k = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sync.anchors[mid].time <= t) {
          k = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (k >= 0) {
        const release = sync.releases[k];
        if (release === undefined || t < release) target = sync.anchors[k].flat;
      }
    }

    if (target === sync.sweepIndex) return;
    if (sync.sweepIndex >= 0 && sync.flatWords[sync.sweepIndex]) {
      sync.flatWords[sync.sweepIndex].wordEl.classList.remove('is-active');
    }
    sync.sweepIndex = target;
    if (target >= 0 && sync.flatWords[target]) {
      sync.flatWords[target].wordEl.classList.add('is-active');
      scrollToLine(sync, sync.flatWords[target].lineEl);
    }
  }

  function formatTime(seconds) {
    seconds = Math.floor(seconds);
    const minutes = Math.floor(seconds / 60);
    seconds = seconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  // ---- Add a Tape uploader ---------------------------------------------------
  // Design only for now: picks up a file / fills the form, but nothing is sent
  // anywhere yet. Wire this to a real upload endpoint later.
  const uploadDrop     = document.getElementById('uploadDrop');
  const uploadFile     = document.getElementById('uploadFile');
  const uploadFileName = document.getElementById('uploadFileName');
  const uploadCategory = document.getElementById('uploadCategory');
  const uploadSubmit   = document.getElementById('uploadSubmit');
  const uploadStatus   = document.getElementById('uploadStatus');

  function setUploadFile(file) {
    uploadFileName.textContent = file.name;
    uploadSubmit.disabled = false;
  }

  ['dragenter', 'dragover'].forEach(evt => {
    uploadDrop.addEventListener(evt, function(e) {
      e.preventDefault();
      uploadDrop.classList.add('is-dragover');
    });
  });
  ['dragleave', 'drop'].forEach(evt => {
    uploadDrop.addEventListener(evt, function(e) {
      e.preventDefault();
      uploadDrop.classList.remove('is-dragover');
    });
  });
  uploadDrop.addEventListener('drop', function(e) {
    const file = e.dataTransfer.files[0];
    if (file) setUploadFile(file);
  });
  uploadFile.addEventListener('change', function() {
    if (this.files[0]) setUploadFile(this.files[0]);
  });
  uploadCategory.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', function() {
      uploadCategory.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('is-active', c === this));
    });
  });
  uploadSubmit.addEventListener('click', function() {
    uploadStatus.textContent = 'Uploads aren\'t wired up yet, this is only a design preview.';
  });
});
