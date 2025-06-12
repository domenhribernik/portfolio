document.addEventListener('DOMContentLoaded', function() {
  const players = {};
  
  let tracks = { electric: [], acoustic: [] };

  fetch('../assets/music/tracks.json')
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
    const trackSrc = `../assets/music/${category}/${track.file}`;
    
    // Create track container
    const trackDiv = document.createElement('div');
    trackDiv.className = 'track';
    trackDiv.setAttribute('data-src', trackSrc);
    trackDiv.setAttribute('data-id', trackId);
    
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
    
    // Add container and controls to track player
    trackPlayer.appendChild(waveformContainer);
    trackPlayer.appendChild(playerControls);
    
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
        waveColor: 'rgba(255, 255, 255, 0.3)',
        progressColor: '#bb86fc',
        cursorColor: '#03dac6',
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
        isLoading: false
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
        } else {
          // Pause all other tracks first
          Object.keys(players).forEach(id => {
            if (id !== trackId && players[id].isPlaying) {
              players[id].wavesurfer.pause();
              players[id].isPlaying = false;
              players[id].element.querySelector('.btn-play i').classList.replace('fa-pause', 'fa-play');
            }
          });
          
          player.wavesurfer.play();
          player.isPlaying = true;
          requestWakeLock();
          playButton.querySelector('i').classList.replace('fa-play', 'fa-pause');
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
      });
      
      wavesurfer.on('finish', function() {
        playButton.querySelector('i').classList.replace('fa-pause', 'fa-play');
        players[trackId].isPlaying = false;
        wakeLock?.release();
        wakeLock = null;
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
      }
    } else {
      track.classList.add('active');
      trackPlayer.classList.remove('hidden');
      
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
  
  function formatTime(seconds) {
    seconds = Math.floor(seconds);
    const minutes = Math.floor(seconds / 60);
    seconds = seconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }
  
  // Don't duplicate this call
  // createTrackElements();
});