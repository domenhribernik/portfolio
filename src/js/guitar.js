document.addEventListener('DOMContentLoaded', function() {
  // Track player objects to manage audio
  const players = {};
  
  // Define your track data - since we're using static files, we'll define the tracks here
  // In a real environment, you'd replace this with a fetch to a JSON file
  let tracks = { electric: [], acoustic: [] };

  fetch('/assets/guitar/tracks.json')
    .then(response => response.json())
    .then(data => {
      tracks = data;
      createTrackElements(); // Call this after tracks are loaded
    })
    .catch(error => console.error('Error loading tracks:', error));
  
  // Function to create track elements
  function createTrackElements() {
    const electricContainer = document.getElementById('electric-tracks');
    const acousticContainer = document.getElementById('acoustic-tracks');
    
    // Generate electric tracks
    tracks.electric.forEach((track, index) => {
      const trackElement = createTrackElement(track, 'electric', index);
      electricContainer.appendChild(trackElement);
    });
    
    // Generate acoustic tracks
    tracks.acoustic.forEach((track, index) => {
      const trackElement = createTrackElement(track, 'acoustic', index);
      acousticContainer.appendChild(trackElement);
    });
    
    // Initialize event listeners
    initializeEventListeners();
  }
  
  // Function to create a single track element
  function createTrackElement(track, category, index) {
    const trackId = `${category}-${index}`;
    const trackSrc = `/assets/guitar/${category}/${track.file}`;
    
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
    
    const waveform = document.createElement('div');
    waveform.className = 'waveform';
    waveform.id = `waveform-${trackId}`;
    
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
    volumeSlider.value = '80';
    
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
    
    trackPlayer.appendChild(waveform);
    trackPlayer.appendChild(playerControls);
    
    trackDiv.appendChild(trackInfo);
    trackDiv.appendChild(trackPlayer);
    
    return trackDiv;
  }
  
  // Function to initialize event listeners
  function initializeEventListeners() {
    const tracks = document.querySelectorAll('.track');
    
    // Initialize each track
    tracks.forEach(track => {
      const trackId = track.getAttribute('data-id');
      const trackSrc = track.getAttribute('data-src');
      const trackInfo = track.querySelector('.track-info');
      const trackPlayer = track.querySelector('.track-player');
      const waveformElement = trackPlayer.querySelector('.waveform');
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
        isPlaying: false
      };
      
      // Add click event to track info to toggle player
      trackInfo.addEventListener('click', function() {
        togglePlayer(trackId, trackSrc);
      });
      
      // Add play button functionality
      playButton.addEventListener('click', function(e) {
        e.stopPropagation(); // Prevent the click from bubbling to track-info
        const player = players[trackId];
        
        if (player.isPlaying) {
          player.wavesurfer.pause();
          player.isPlaying = false;
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
      wavesurfer.on('ready', function() {
        const duration = wavesurfer.getDuration();
        totalTimeSpan.textContent = formatTime(duration);
        track.querySelector('.track-duration').textContent = formatTime(duration);
        players[trackId].isLoaded = true;
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
      });
      
      // Click on progress bar to seek
      trackPlayer.querySelector('.progress-bar').addEventListener('click', function(e) {
        e.stopPropagation(); // Prevent the click from bubbling
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
  
  // Function to toggle player visibility and load audio
  function togglePlayer(trackId, src) {
    const player = players[trackId];
    const track = player.element;
    const trackPlayer = track.querySelector('.track-player');
    
    // Check if this track is already open
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
        }
        
        t.classList.remove('active');
        t.querySelector('.track-player').classList.add('hidden');
      }
    });
    
    // Toggle this track
    if (isOpen) {
      // Close this track
      track.classList.remove('active');
      trackPlayer.classList.add('hidden');
      
      if (player.isPlaying) {
        player.wavesurfer.pause();
        player.isPlaying = false;
        track.querySelector('.btn-play i').classList.replace('fa-pause', 'fa-play');
      }
    } else {
      // Open this track
      track.classList.add('active');
      trackPlayer.classList.remove('hidden');
      
      // Load audio if not already loaded
      if (!player.isLoaded) {
        player.wavesurfer.load(src);
      }
    }
  }
  
  // Helper function to format time in MM:SS
  function formatTime(seconds) {
    seconds = Math.floor(seconds);
    const minutes = Math.floor(seconds / 60);
    seconds = seconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }
  
  createTrackElements();
});