document.addEventListener('DOMContentLoaded', function() {
  const players = {};
  const SYNC_API = '../../app/controllers/music-controller.php';
  const TABS_API = '../../app/proxys/tabs-proxy.php';
  const GAP_CHORDS = ['', 'N.C.', 'NC', '-'];

  let tracks = { electric: [], acoustic: [] };

  // "Now playing" marquee. Only one track ever plays at a time, so a single
  // shared ticker is enough. The two spans are duplicated for a seamless loop.
  const nowPlayingEl = document.getElementById('nowPlaying');
  const npTexts = [document.getElementById('npText1'), document.getElementById('npText2')];
  const NP_IDLE = 'Press play on any track to start the tape';

  function setNowPlaying(name) {
    if (!nowPlayingEl) return;
    const text = name ? `♪  ${name}` : NP_IDLE;
    npTexts.forEach(el => { if (el) el.textContent = text; });
    nowPlayingEl.setAttribute('data-playing', name ? 'true' : 'false');
  }

  fetch('../../assets/music/tracks.json')
    .then(response => response.json())
    .then(data => {
      tracks = data;
      createTrackElements(); // Call this after tracks are loaded
    })
    .catch(error => console.error('Error loading tracks:', error));

  function createTrackElements() {
    const electricContainer = document.getElementById('electric-tracks');
    const acousticContainer = document.getElementById('acoustic-tracks');

    tracks.electric.forEach((track, index) => {
      const trackElement = createTrackElement(track, 'electric', index);
      electricContainer.appendChild(trackElement);
    });

    tracks.acoustic.forEach((track, index) => {
      const trackElement = createTrackElement(track, 'acoustic', index);
      acousticContainer.appendChild(trackElement);
    });

    initializeEventListeners();
  }

  function createTrackElement(track, category, index) {
    const trackId = `${category}-${index}`;
    const trackSrc = `../../assets/music/${category}/${track.file}`;

    // Create track container
    const trackDiv = document.createElement('div');
    trackDiv.className = 'track';
    trackDiv.setAttribute('data-src', trackSrc);
    trackDiv.setAttribute('data-id', trackId);
    trackDiv.setAttribute('data-key', `${category}/${track.file}`);

    // Create track info section
    const trackInfo = document.createElement('div');
    trackInfo.className = 'track-info';

    const trackName = document.createElement('div');
    trackName.className = 'track-name';
    trackName.textContent = track.name;

    const trackControls = document.createElement('div');
    trackControls.className = 'track-controls';

    const trackDuration = document.createElement('span');
    trackDuration.className = 'track-duration';
    trackDuration.textContent = '0:00';

    const trackToggle = document.createElement('span');
    trackToggle.className = 'track-toggle';
    trackToggle.innerHTML = '<i class="fas fa-chevron-down"></i>';

    trackControls.appendChild(trackDuration);
    trackControls.appendChild(trackToggle);

    trackInfo.appendChild(trackName);
    trackInfo.appendChild(trackControls);

    // Create track player section
    const trackPlayer = document.createElement('div');
    trackPlayer.className = 'track-player hidden';

    // Create waveform container which will hold both waveform and loading spinner
    const waveformContainer = document.createElement('div');
    waveformContainer.className = 'waveform-container';

    const waveform = document.createElement('div');
    waveform.className = 'waveform';
    waveform.id = `waveform-${trackId}`;

    // Create loading spinner inside waveform container
    const loadingSpinner = document.createElement('div');
    loadingSpinner.className = 'loading-spinner-music hidden';
    loadingSpinner.innerHTML = '<i class="fas fa-spinner fa-pulse"></i>';

    // Add waveform and loading spinner to the container
    waveformContainer.appendChild(waveform);
    waveformContainer.appendChild(loadingSpinner);

    const playerControls = document.createElement('div');
    playerControls.className = 'player-controls';

    // Play button
    const playButton = document.createElement('button');
    playButton.className = 'btn-play';
    playButton.innerHTML = '<i class="fas fa-play"></i>';

    // Volume container
    const volumeContainer = document.createElement('div');
    volumeContainer.className = 'volume-container';

    const volumeIcon = document.createElement('i');
    volumeIcon.className = 'fas fa-volume-up';

    const volumeSlider = document.createElement('input');
    volumeSlider.className = 'volume-slider';
    volumeSlider.type = 'range';
    volumeSlider.min = '0';
    volumeSlider.max = '100';
    volumeSlider.value = '100';

    volumeContainer.appendChild(volumeIcon);
    volumeContainer.appendChild(volumeSlider);

    // Track progress
    const trackProgress = document.createElement('div');
    trackProgress.className = 'track-progress';

    const currentTime = document.createElement('span');
    currentTime.className = 'current-time';
    currentTime.textContent = '0:00';

    const progressBar = document.createElement('div');
    progressBar.className = 'progress-bar';

    const progress = document.createElement('div');
    progress.className = 'progress';

    const totalTime = document.createElement('span');
    totalTime.className = 'total-time';
    totalTime.textContent = '0:00';

    progressBar.appendChild(progress);

    trackProgress.appendChild(currentTime);
    trackProgress.appendChild(progressBar);
    trackProgress.appendChild(totalTime);

    playerControls.appendChild(playButton);
    playerControls.appendChild(volumeContainer);
    playerControls.appendChild(trackProgress);

    // Songsterr tab link; href is filled in by the proxy on first deck open
    const tabLink = document.createElement('a');
    tabLink.className = 'btn-tab hidden';
    tabLink.target = '_blank';
    tabLink.rel = 'noopener';
    tabLink.innerHTML = '<i class="fas fa-guitar"></i> Tab';
    tabLink.addEventListener('click', e => e.stopPropagation());
    playerControls.appendChild(tabLink);

    // Cassette "deck": two reels flank the waveform and spin while playing.
    const deck = document.createElement('div');
    deck.className = 'deck';

    const reelLeft = document.createElement('span');
    reelLeft.className = 'reel reel--left';
    const reelRight = document.createElement('span');
    reelRight.className = 'reel reel--right';

    deck.appendChild(reelLeft);
    deck.appendChild(waveformContainer);
    deck.appendChild(reelRight);

    // Add deck and controls to track player
    trackPlayer.appendChild(deck);
    trackPlayer.appendChild(playerControls);

    // Chords + lyrics songbook; filled from the DB the first time the deck opens
    const chordSheet = document.createElement('div');
    chordSheet.className = 'chordsheet hidden';
    trackPlayer.appendChild(chordSheet);

    trackDiv.appendChild(trackInfo);
    trackDiv.appendChild(trackPlayer);

    return trackDiv;
  }

  function initializeEventListeners() {
    const tracks = document.querySelectorAll('.track');

    // Initialize each track
    tracks.forEach(track => {
      const trackId = track.getAttribute('data-id');
      const trackSrc = track.getAttribute('data-src');
      const trackInfo = track.querySelector('.track-info');
      const trackPlayer = track.querySelector('.track-player');
      const waveformElement = trackPlayer.querySelector('.waveform');
      const loadingSpinner = trackPlayer.querySelector('.loading-spinner-music');
      const playButton = trackPlayer.querySelector('.btn-play');
      const volumeSlider = trackPlayer.querySelector('.volume-slider');
      const currentTimeSpan = trackPlayer.querySelector('.current-time');
      const totalTimeSpan = trackPlayer.querySelector('.track-progress .total-time');
      const progressBar = trackPlayer.querySelector('.progress');

      // Create wavesurfer instance for this track
      const wavesurfer = WaveSurfer.create({
        container: waveformElement,
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

      // Store player reference
      players[trackId] = {
        element: track,
        wavesurfer: wavesurfer,
        isLoaded: false,
        isPlaying: false,
        isLoading: false,
        trackKey: track.getAttribute('data-key'),
        trackName: track.querySelector('.track-name').textContent,
        sync: null,          // rendered chord/lyrics refs once loaded
        syncState: 'idle',   // idle | loading | loaded | empty | error
        tabState: 'idle'
      };

      // Add click event to track info to toggle player
      trackInfo.addEventListener('click', function() {
        togglePlayer(trackId, trackSrc);
      });

      // Add play button functionality
      playButton.addEventListener('click', function(e) {
        e.stopPropagation(); // Prevent the click from bubbling to track-info
        const player = players[trackId];

        // If still loading, ignore the click
        if (player.isLoading) {
          return;
        }

        if (player.isPlaying) {
          player.wavesurfer.pause();
          player.isPlaying = false;
          wakeLock?.release();
          wakeLock = null;
          playButton.querySelector('i').classList.replace('fa-pause', 'fa-play');
          track.classList.remove('is-playing');
          setNowPlaying(null);
        } else {
          // Pause all other tracks first
          Object.keys(players).forEach(id => {
            if (id !== trackId && players[id].isPlaying) {
              players[id].wavesurfer.pause();
              players[id].isPlaying = false;
              players[id].element.classList.remove('is-playing');
              players[id].element.querySelector('.btn-play i').classList.replace('fa-pause', 'fa-play');
            }
          });

          player.wavesurfer.play();
          player.isPlaying = true;
          requestWakeLock();
          playButton.querySelector('i').classList.replace('fa-play', 'fa-pause');
          track.classList.add('is-playing');
          setNowPlaying(track.querySelector('.track-name').textContent);
        }
      });

      // Add volume control
      volumeSlider.addEventListener('input', function(e) {
        e.stopPropagation(); // Prevent the click from bubbling
        const volume = parseFloat(this.value) / 100;
        players[trackId].wavesurfer.setVolume(volume);
      });

      // Handle wavesurfer events
      wavesurfer.on('loading', function(percent) {
        console.log(`Loading track ${trackId}: ${percent}%`);
        loadingSpinner.classList.remove('hidden');
        players[trackId].isLoading = true;

        // Hide the player controls during loading
        const playerControls = trackPlayer.querySelector('.player-controls');
        playerControls.classList.add('loading');
      });

      // Then update the 'ready' event handler:
      wavesurfer.on('ready', function() {
        console.log(`Track ${trackId} is ready`);
        const duration = wavesurfer.getDuration();
        totalTimeSpan.textContent = formatTime(duration);
        track.querySelector('.track-duration').textContent = formatTime(duration);
        players[trackId].isLoaded = true;
        players[trackId].isLoading = false;
        loadingSpinner.classList.add('hidden');

        // Show the controls now that loading is complete
        const playerControls = trackPlayer.querySelector('.player-controls');
        playerControls.classList.remove('loading');
      });

      wavesurfer.on('audioprocess', function() {
        const currentTime = wavesurfer.getCurrentTime();
        currentTimeSpan.textContent = formatTime(currentTime);

        // Update progress bar
        const progress = (currentTime / wavesurfer.getDuration()) * 100;
        progressBar.style.width = `${progress}%`;

        updateChordSync(trackId, currentTime);
      });

      wavesurfer.on('seek', function() {
        updateChordSync(trackId, wavesurfer.getCurrentTime());
      });

      wavesurfer.on('finish', function() {
        playButton.querySelector('i').classList.replace('fa-pause', 'fa-play');
        players[trackId].isPlaying = false;
        wakeLock?.release();
        wakeLock = null;
        track.classList.remove('is-playing');
        setNowPlaying(null);
        updateChordSync(trackId, 0);
      });

      // Error handling
      wavesurfer.on('error', function(err) {
        console.error(`WaveSurfer error for track ${trackId}:`, err);
        loadingSpinner.classList.add('hidden');
        players[trackId].isLoading = false;
        players[trackId].isLoaded = false;

        // Show controls even on error
        const playerControls = trackPlayer.querySelector('.player-controls');
        playerControls.classList.remove('loading');

        alert('Error loading audio: ' + err);
      });

      // Click on progress bar to seek
      trackPlayer.querySelector('.progress-bar').addEventListener('click', function(e) {
        e.stopPropagation(); // Prevent the click from bubbling

        if (players[trackId].isLoading) {
          return; // Don't allow seeking while loading
        }

        const rect = this.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const seekPercentage = x / rect.width;

        wavesurfer.seekTo(seekPercentage);
      });
    });

    // For better UX, implement key controls when a track is active
    document.addEventListener('keydown', function(e) {
      // Find the active track
      const activeTrack = document.querySelector('.track.active');
      if (!activeTrack) return;

      const trackId = activeTrack.getAttribute('data-id');
      const player = players[trackId];

      // If track is loading, ignore keyboard controls
      if (player.isLoading) {
        return;
      }

      // Space bar to play/pause
      if (e.code === 'Space') {
        e.preventDefault();
        activeTrack.querySelector('.btn-play').click();
      }

      // Arrow left/right for seek
      if (e.code === 'ArrowLeft' && player.isLoaded) {
        const currentTime = player.wavesurfer.getCurrentTime();
        player.wavesurfer.seekTo((Math.max(0, currentTime - 5)) / player.wavesurfer.getDuration());
      }

      if (e.code === 'ArrowRight' && player.isLoaded) {
        const currentTime = player.wavesurfer.getCurrentTime();
        player.wavesurfer.seekTo((Math.min(player.wavesurfer.getDuration(), currentTime + 5)) / player.wavesurfer.getDuration());
      }

      // Arrow up/down for volume
      if (e.code === 'ArrowUp' && player.isLoaded) {
        const volumeSlider = activeTrack.querySelector('.volume-slider');
        const newVolume = Math.min(100, parseInt(volumeSlider.value) + 5);
        volumeSlider.value = newVolume;
        player.wavesurfer.setVolume(newVolume / 100);
      }

      if (e.code === 'ArrowDown' && player.isLoaded) {
        const volumeSlider = activeTrack.querySelector('.volume-slider');
        const newVolume = Math.max(0, parseInt(volumeSlider.value) - 5);
        volumeSlider.value = newVolume;
        player.wavesurfer.setVolume(newVolume / 100);
      }
    });
  }

  let wakeLock = null;

  async function requestWakeLock() {
      try {
          wakeLock = await navigator.wakeLock.request('screen');
          console.log('Wake Lock is active');

          wakeLock.addEventListener('release', () => {
              console.log('Wake Lock was released');
          });
      } catch (err) {
          console.error(`${err.name}, ${err.message}`);
      }
  }

  function togglePlayer(trackId, src) {
    const player = players[trackId];
    const track = player.element;
    const trackPlayer = track.querySelector('.track-player');
    const loadingSpinner = trackPlayer.querySelector('.loading-spinner-music');

    const isOpen = !trackPlayer.classList.contains('hidden');

    // Close all other tracks first
    document.querySelectorAll('.track').forEach(t => {
      if (t !== track) {
        const tId = t.getAttribute('data-id');
        const p = players[tId];

        if (p && p.isPlaying) {
          p.wavesurfer.pause();
          p.isPlaying = false;
          t.querySelector('.btn-play i').classList.replace('fa-pause', 'fa-play');
          wakeLock?.release();
          wakeLock = null;
          t.classList.remove('is-playing');
          setNowPlaying(null);
        }

        t.classList.remove('active');
        t.querySelector('.track-player').classList.add('hidden');
      }
    });

    if (isOpen) {
      track.classList.remove('active');
      trackPlayer.classList.add('hidden');

      if (player.isPlaying) {
        player.wavesurfer.pause();
        player.isPlaying = false;
        wakeLock?.release();
        wakeLock = null;
        track.querySelector('.btn-play i').classList.replace('fa-pause', 'fa-play');
        track.classList.remove('is-playing');
        setNowPlaying(null);
      }
    } else {
      track.classList.add('active');
      trackPlayer.classList.remove('hidden');

      if (player.syncState === 'idle') {
        loadChordSheet(trackId);
      }
      if (player.tabState === 'idle') {
        loadTabLink(trackId);
      }

      if (!player.isLoaded) {
        // Show loading spinner before loading starts
        loadingSpinner.classList.remove('hidden');
        player.isLoading = true;
        trackPlayer.querySelector('.player-controls').classList.add('loading');
        console.log(`Loading track ${trackId} from ${src}`);
        player.wavesurfer.load(src);
      }
    }
  }

  // ---- Chords + lyrics songbook -----------------------------------------

  function isGapChord(name) {
    return GAP_CHORDS.includes((name || '').trim());
  }

  function loadTabLink(trackId) {
    const player = players[trackId];
    player.tabState = 'loading';
    const query = player.trackName.replace(/\s+-\s+/g, ' ');

    fetch(`${TABS_API}?q=${encodeURIComponent(query)}`)
      .then(response => (response.ok ? response.json() : Promise.reject()))
      .then(data => {
        player.tabState = 'done';
        if (!data.found) return;
        const link = player.element.querySelector('.btn-tab');
        link.href = data.url;
        link.title = `Guitar tab on Songsterr: ${data.artist} - ${data.title}`;
        link.classList.remove('hidden');
      })
      .catch(() => {
        player.tabState = 'error'; // quietly: a missing tab button is fine
      });
  }

  function loadChordSheet(trackId) {
    const player = players[trackId];
    const sheet = player.element.querySelector('.chordsheet');
    player.syncState = 'loading';

    fetch(`${SYNC_API}?resource=sync&track=${encodeURIComponent(player.trackKey)}`)
      .then(response => {
        if (response.status === 404) {
          player.syncState = 'empty';
          renderChordSheetEmpty(player, sheet);
          return null;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(data => {
        if (!data) return;
        player.syncState = 'loaded';
        renderChordSheet(player, sheet, data);
      })
      .catch(error => {
        console.error(`Error loading chords for ${player.trackKey}:`, error);
        player.syncState = 'error';
        sheet.classList.remove('hidden');
        sheet.innerHTML = '';
        sheet.classList.add('chordsheet--empty');
        const msg = document.createElement('p');
        msg.className = 'chordsheet__message';
        msg.textContent = 'Chords and lyrics are unavailable right now (backend offline).';
        sheet.appendChild(msg);
      });
  }

  function renderChordSheetEmpty(player, sheet) {
    sheet.classList.remove('hidden');
    sheet.classList.add('chordsheet--empty');
    sheet.innerHTML = '';

    const msg = document.createElement('p');
    msg.className = 'chordsheet__message';
    msg.textContent = 'No chords or lyrics for this track yet.';

    const link = document.createElement('a');
    link.className = 'chordsheet__link';
    link.href = `editor/?track=${encodeURIComponent(player.trackKey)}`;
    link.innerHTML = '<i class="fas fa-pen-nib"></i> Add them in the editor';

    sheet.appendChild(msg);
    sheet.appendChild(link);
  }

  function renderChordSheet(player, sheet, data) {
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
          chordEl.textContent = ' ';
        }

        const textEl = document.createElement('span');
        textEl.className = 'cs-word-text';
        textEl.textContent = word;

        wordEl.appendChild(chordEl);
        wordEl.appendChild(textEl);
        lineEl.appendChild(wordEl);

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

    // Sweep segments: between two consecutive anchored chords the word
    // highlight advances linearly with playback time, karaoke style.
    const segments = [];
    for (let i = 0; i < events.length - 1; i++) {
      if (eventFlat[i] >= 0 && eventFlat[i + 1] > eventFlat[i] && events[i + 1].time > events[i].time) {
        segments.push({
          start: events[i].time,
          end: events[i + 1].time,
          from: eventFlat[i],
          to: eventFlat[i + 1]
        });
      }
    }

    sheet.appendChild(body);

    player.sync = {
      events: events,
      eventEls: eventEls,
      eventFlat: eventFlat,
      flatWords: flatWords,
      segments: segments,
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

  function updateChordSync(trackId, currentTime) {
    const sync = players[trackId]?.sync;
    if (!sync || !sync.events.length) return;

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
    if (target === -1 && sync.activeIndex >= 0 && sync.eventFlat[sync.activeIndex] >= 0) {
      // not inside a sweep segment: park on the active chord's own word
      target = sync.eventFlat[sync.activeIndex];
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

  // Don't duplicate this call
  // createTrackElements();
});
