document.addEventListener('DOMContentLoaded', function() {
  const players = {};
  const SYNC_API = '../../app/controllers/music-controller.php';
  const TABS_API = '../../app/proxys/tabs-proxy.php';
  const GAP_CHORDS = ['', 'N.C.', 'NC', '-'];

  let tracks = { electric: [], acoustic: [] };

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

    // Practice speed: 50-100% playback rate; the MediaElement backend keeps
    // the pitch, so slowed songs stay in tune for playing along
    const rateGroup = document.createElement('div');
    rateGroup.className = 'rate-group';
    [0.5, 0.75, 0.9, 1].forEach(rate => {
      const button = document.createElement('button');
      button.className = 'btn-mini' + (rate === 1 ? ' is-active' : '');
      button.dataset.rate = String(rate);
      button.textContent = `${rate * 100}%`;
      button.title = `Play at ${rate * 100}% speed`;
      rateGroup.appendChild(button);
    });

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
    playerControls.appendChild(rateGroup);
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

      // Create wavesurfer instance for this track. MediaElement backend so
      // the practice speed control keeps the pitch (WebAudio rate would
      // detune the song).
      const wavesurfer = WaveSurfer.create({
        container: waveformElement,
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

      // Store player reference
      players[trackId] = {
        element: track,
        wavesurfer: wavesurfer,
        isLoaded: false,
        isPlaying: false,
        isLoading: false,
        trackKey: track.getAttribute('data-key'),
        trackName: track.querySelector('.track-name').textContent,
        rate: 1,             // practice playback speed
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
        }
      });

      // Add volume control
      volumeSlider.addEventListener('input', function(e) {
        e.stopPropagation(); // Prevent the click from bubbling
        const volume = parseFloat(this.value) / 100;
        players[trackId].wavesurfer.setVolume(volume);
      });

      // Practice speed buttons
      trackPlayer.querySelectorAll('.rate-group .btn-mini').forEach(button => {
        button.addEventListener('click', function(e) {
          e.stopPropagation();
          const rate = parseFloat(this.dataset.rate);
          players[trackId].rate = rate;
          if (players[trackId].isLoaded) wavesurfer.setPlaybackRate(rate);
          this.closest('.rate-group').querySelectorAll('.btn-mini').forEach(b => {
            b.classList.toggle('is-active', b === this);
          });
        });
      });

      // Handle wavesurfer events
      wavesurfer.on('loading', function(percent) {
        // With the MediaElement backend, 'loading' tracks the separate
        // waveform download, which keeps firing after 'ready' (the media is
        // playable long before the full file is fetched for drawing). Once
        // ready, never fall back into the loading state.
        if (players[trackId].isLoaded) return;
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

        // keep the pitch when slowed down; apply a rate picked while loading
        const media = wavesurfer.backend && wavesurfer.backend.media;
        if (media) {
          media.preservesPitch = true;
          media.webkitPreservesPitch = true;
        }
        wavesurfer.setPlaybackRate(players[trackId].rate);

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
        updateChordSync(trackId, 0);
      });

      // Error handling
      wavesurfer.on('error', function(err) {
        console.error(`WaveSurfer error for track ${trackId}:`, err);
        // a waveform decode hiccup after the media is already playable
        // isn't fatal: keep the controls, just miss the wave drawing
        if (players[trackId].isLoaded) return;
        loadingSpinner.classList.add('hidden');
        players[trackId].isLoading = false;

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

    if (syncIndex && !syncIndex.has(player.trackKey)) {
      player.syncState = 'empty';
      renderChordSheetEmpty(player, sheet);
      return;
    }

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
          chordEl.textContent = ' ';
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

    // Sweep anchors: every timestamped word position, from anchored chords
    // plus the editor's explicit word syncs. Between two consecutive anchors
    // the highlight interpolates linearly, karaoke style; the more word syncs
    // exist, the less it has to guess.
    const sweepAnchors = [];
    events.forEach((event, i) => {
      if (eventFlat[i] >= 0) sweepAnchors.push({ time: event.time, flat: eventFlat[i] });
    });
    (data.words || []).forEach(mark => {
      if (typeof mark.time !== 'number') return;
      const flat = flatByPos[`${mark.line}:${mark.word}`];
      if (flat !== undefined) sweepAnchors.push({ time: mark.time, flat: flat });
    });
    sweepAnchors.sort((a, b) => a.time - b.time || a.flat - b.flat);

    // times where singing stops: unanchored chord events (instrumental runs
    // and explicit N.C. gaps)
    const gapTimes = events.filter((e, i) => eventFlat[i] < 0).map(e => e.time);
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

    player.sync = {
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

  // Don't duplicate this call
  // createTrackElements();
});
