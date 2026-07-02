document.addEventListener('DOMContentLoaded', function() {
  const API = '../../../app/controllers/music-controller.php';
  const MAX_BYTES = 30 * 1024 * 1024;

  const dropzone     = document.getElementById('dropzone');
  const fileInput    = document.getElementById('fileInput');
  const fileLabel    = document.getElementById('fileLabel');
  const analyzeBtn   = document.getElementById('analyzeBtn');
  const saveCheck    = document.getElementById('saveCheck');
  const uploadStatus = document.getElementById('uploadStatus');
  const loadingPanel = document.getElementById('loadingPanel');
  const results      = document.getElementById('results');
  const resultsTitle = document.getElementById('resultsTitle');
  const savedNote    = document.getElementById('savedNote');
  const warningsBox  = document.getElementById('warningsBox');
  const statGrid     = document.getElementById('statGrid');
  const progPanel    = document.getElementById('progressionPanel');
  const progRow      = document.getElementById('progRow');
  const timelineDetails = document.getElementById('timelineDetails');
  const timelineList = document.getElementById('timelineList');
  const scalesPanel  = document.getElementById('scalesPanel');
  const scalesBody   = document.getElementById('scalesBody');
  const improvPanel  = document.getElementById('improvPanel');
  const improvBody   = document.getElementById('improvBody');
  const recentPanel  = document.getElementById('recentPanel');
  const recentList   = document.getElementById('recentList');

  let selectedFile = null;
  let analyzing = false;

  // ---- File selection -------------------------------------------------------

  function showUploadStatus(message, kind) {
    uploadStatus.textContent = message;
    uploadStatus.classList.remove('hidden', 'status-line--error', 'status-line--ok');
    if (kind === 'error') uploadStatus.classList.add('status-line--error');
    if (kind === 'ok') uploadStatus.classList.add('status-line--ok');
  }

  function setChosen(file) {
    selectedFile = file;
    analyzeBtn.disabled = false;
    fileLabel.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
    fileLabel.classList.remove('hidden');
    uploadStatus.classList.add('hidden');
  }

  function pickFile(file) {
    if (!file) return;
    if (!/\.mp3$/i.test(file.name)) {
      selectedFile = null;
      analyzeBtn.disabled = true;
      fileLabel.classList.add('hidden');
      showUploadStatus(`"${file.name}" is not an MP3. Only .mp3 files are accepted.`, 'error');
      return;
    }
    if (file.size > MAX_BYTES) {
      selectedFile = null;
      analyzeBtn.disabled = true;
      fileLabel.classList.add('hidden');
      showUploadStatus('That file is over the 30 MB limit.', 'error');
      return;
    }
    setChosen(file);
  }

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => pickFile(fileInput.files[0]));

  ['dragenter', 'dragover'].forEach(name => dropzone.addEventListener(name, e => {
    e.preventDefault();
    dropzone.classList.add('is-dragover');
  }));
  ['dragleave', 'drop'].forEach(name => dropzone.addEventListener(name, e => {
    e.preventDefault();
    dropzone.classList.remove('is-dragover');
  }));
  dropzone.addEventListener('drop', e => pickFile(e.dataTransfer.files[0]));

  // ---- Mic recording (shazam-style) -------------------------------------------
  // Records up to 90s through getUserMedia, wraps the blob as a File and feeds
  // it down the exact same analyze pipeline as an uploaded MP3.

  const recorderCard = document.getElementById('recorder');
  const recordBtn    = document.getElementById('recordBtn');
  const recordTimer  = document.getElementById('recordTimer');
  const REC_MAX_MS = 90000;

  let mediaRecorder = null;
  let recChunks = [];
  let recStream = null;
  let recStartTs = 0;
  let recTick = null;
  let recStopTimeout = null;

  recordBtn.addEventListener('click', function() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      stopRecording();
    } else {
      startRecording();
    }
  });

  function startRecording() {
    if (analyzing) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      showUploadStatus('Recording is not supported in this browser.', 'error');
      return;
    }
    // music fidelity: keep the browser from "cleaning up" the signal
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    })
      .then(stream => {
        recStream = stream;
        const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
          .find(t => MediaRecorder.isTypeSupported(t)) || '';
        mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        recChunks = [];
        mediaRecorder.ondataavailable = e => { if (e.data.size) recChunks.push(e.data); };
        mediaRecorder.onstop = finishRecording;
        mediaRecorder.start();

        recStartTs = Date.now();
        recorderCard.classList.add('is-recording');
        recordBtn.innerHTML = '<i class="fas fa-stop"></i> Stop';
        recordTimer.textContent = '0:00 / 1:30';
        recordTimer.classList.remove('hidden');
        recTick = setInterval(() => {
          const s = Math.floor((Date.now() - recStartTs) / 1000);
          recordTimer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} / 1:30`;
        }, 250);
        recStopTimeout = setTimeout(stopRecording, REC_MAX_MS);
        uploadStatus.classList.add('hidden');
      })
      .catch(error => {
        showUploadStatus('Could not access the microphone: ' + error.message, 'error');
      });
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
  }

  function finishRecording() {
    clearInterval(recTick);
    clearTimeout(recStopTimeout);
    if (recStream) recStream.getTracks().forEach(t => t.stop());
    recorderCard.classList.remove('is-recording');
    recordBtn.innerHTML = '<i class="fas fa-circle"></i> Record';
    recordTimer.classList.add('hidden');

    const seconds = Math.round((Date.now() - recStartTs) / 1000);
    const type = mediaRecorder.mimeType || 'audio/webm';
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    const blob = new Blob(recChunks, { type });

    if (seconds < 3 || blob.size < 2048) {
      showUploadStatus('That recording was too short. Give it at least a few seconds of the song.', 'error');
      return;
    }

    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    setChosen(new File([blob], `mic-recording-${stamp}.${ext}`, { type }));
    showUploadStatus(`Recorded ${seconds}s from the mic, ready to analyze.`, 'ok');
  }

  // ---- Analyze ----------------------------------------------------------------

  analyzeBtn.addEventListener('click', function() {
    if (!selectedFile || analyzing) return;
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      showUploadStatus('Stop the recording first, then analyze.', 'error');
      return;
    }
    analyzing = true;
    analyzeBtn.disabled = true;
    uploadStatus.classList.add('hidden');
    results.classList.add('hidden');
    loadingPanel.classList.remove('hidden');

    const form = new FormData();
    form.append('audio', selectedFile);
    form.append('save', saveCheck.checked ? '1' : '0');

    fetch(API + '?resource=analysis', { method: 'POST', body: form })
      .then(r => r.json().then(body => ({ ok: r.ok, body })).catch(() => {
        throw new Error('The server returned an unreadable response.');
      }))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || 'Analysis failed');
        renderResults(body.filename, body.result, body.saved);
        if (body.saved) loadRecent();
      })
      .catch(error => {
        showUploadStatus('Analysis failed: ' + error.message, 'error');
      })
      .finally(() => {
        analyzing = false;
        analyzeBtn.disabled = !selectedFile;
        loadingPanel.classList.add('hidden');
      });
  });

  // ---- Render results ------------------------------------------------------------

  function statCard(label, value, note) {
    const card = document.createElement('div');
    card.className = 'stat-card' + (value === null ? ' stat-card--missing' : '');

    const labelEl = document.createElement('p');
    labelEl.className = 'stat-card__label';
    labelEl.textContent = label;

    const valueEl = document.createElement('p');
    valueEl.className = 'stat-card__value';
    valueEl.textContent = value === null ? '?' : value;

    card.appendChild(labelEl);
    card.appendChild(valueEl);

    if (note) {
      const noteEl = document.createElement('p');
      noteEl.className = 'stat-card__note';
      noteEl.textContent = note;
      card.appendChild(noteEl);
    }
    return card;
  }

  function tuningText(cents) {
    if (cents === null || cents === undefined) return null;
    if (Math.abs(cents) < 3) return 'in tune (A440)';
    return `${Math.abs(cents).toFixed(0)} cents ${cents > 0 ? 'sharp' : 'flat'}`;
  }

  function renderResults(filename, result, saved) {
    results.classList.remove('hidden');
    resultsTitle.textContent = filename;
    savedNote.textContent = saved ? 'saved to the library' : 'not saved';

    // Warnings (partial failures)
    warningsBox.innerHTML = '';
    const warnings = result.warnings || [];
    if (warnings.length) {
      warnings.forEach(w => {
        const p = document.createElement('p');
        p.textContent = '! ' + w;
        warningsBox.appendChild(p);
      });
      warningsBox.classList.remove('hidden');
    } else {
      warningsBox.classList.add('hidden');
    }

    // Stat cards
    statGrid.innerHTML = '';
    const tempo = result.tempo;
    statGrid.appendChild(statCard('Tempo', tempo ? `${tempo.bpm} BPM` : null,
      tempo ? `confidence: ${tempo.confidence}` : 'could not detect'));

    const meter = result.time_signature;
    statGrid.appendChild(statCard('Time signature', meter ? meter.value : null,
      meter ? `confidence: ${meter.confidence}` : 'could not detect'));

    const key = result.key;
    statGrid.appendChild(statCard('Key', key ? key.name : null,
      key ? `confidence: ${Math.round(key.confidence * 100)}%` : 'could not detect'));

    if (key) {
      statGrid.appendChild(statCard('Relative key', key.relative || null,
        key.parallel ? `parallel: ${key.parallel}` : ''));
    }

    const capo = result.capo;
    if (capo) {
      statGrid.appendChild(statCard('Capo', capo.position === 0 ? 'none' : `fret ${capo.position}`, capo.note));
    }

    const tuning = tuningText(result.tuning_cents);
    if (tuning !== null) {
      statGrid.appendChild(statCard('Tuning', tuning,
        `analyzed ${Math.round(result.duration_analyzed || 0)}s of audio`));
    }

    // Progression
    const chords = result.chords;
    if (chords && chords.progression && chords.progression.length) {
      progPanel.classList.remove('hidden');
      progRow.innerHTML = '';

      const degreeByChord = {};
      (result.degrees || []).forEach(d => { degreeByChord[d.chord] = d; });

      chords.progression.forEach((name, index) => {
        if (index > 0) {
          const arrow = document.createElement('span');
          arrow.className = 'prog-arrow';
          arrow.textContent = '–';
          progRow.appendChild(arrow);
        }
        const info = degreeByChord[name];
        const chip = document.createElement('div');
        chip.className = 'prog-chip' + (info && !info.diatonic ? ' prog-chip--borrowed' : '');
        chip.setAttribute('data-chord-anchor', '');
        chip.title = 'Show the chord diagram';
        chip.addEventListener('click', () => ChordCard.show(name, chip));

        const nameEl = document.createElement('span');
        nameEl.className = 'prog-chip__name';
        nameEl.textContent = name;

        const degreeEl = document.createElement('span');
        degreeEl.className = 'prog-chip__degree';
        degreeEl.textContent = info ? (info.degree + (info.diatonic ? '' : ' (borrowed)')) : '·';

        chip.appendChild(nameEl);
        chip.appendChild(degreeEl);
        progRow.appendChild(chip);
      });

      timelineList.innerHTML = '';
      const timeline = chords.timeline || [];
      timelineDetails.classList.toggle('hidden', !timeline.length);
      timeline.forEach(event => {
        const item = document.createElement('span');
        item.className = 'timeline-item' + (event.chord === 'N.C.' ? ' timeline-item--gap' : '');
        const m = Math.floor(event.time / 60);
        const s = Math.floor(event.time % 60).toString().padStart(2, '0');
        item.textContent = `${m}:${s} ${event.chord}`;
        if (event.chord !== 'N.C.') {
          item.setAttribute('data-chord-anchor', '');
          item.title = 'Show the chord diagram';
          item.addEventListener('click', () => ChordCard.show(event.chord, item));
        }
        timelineList.appendChild(item);
      });
    } else {
      progPanel.classList.add('hidden');
    }

    // Scales
    const scales = result.scales;
    if (scales) {
      scalesPanel.classList.remove('hidden');
      scalesBody.innerHTML = '';

      const primary = document.createElement('p');
      primary.className = 'scale-primary';
      primary.textContent = scales.primary;
      scalesBody.appendChild(primary);

      if (scales.fit_percent !== undefined) {
        const fit = document.createElement('p');
        fit.className = 'scale-fit';
        fit.textContent = `${scales.fit_percent}% of the song's tonal energy sits inside this scale`;
        scalesBody.appendChild(fit);
      }

      const list = document.createElement('ul');
      list.className = 'scale-list';
      list.style.marginTop = '0.9rem';
      (scales.suggestions || []).forEach(s => {
        const li = document.createElement('li');
        li.textContent = s;
        list.appendChild(li);
      });
      scalesBody.appendChild(list);
    } else {
      scalesPanel.classList.add('hidden');
    }

    // Improvisation tips
    const tips = result.improvise;
    if (tips && tips.length) {
      improvPanel.classList.remove('hidden');
      improvBody.innerHTML = '';
      const list = document.createElement('ul');
      list.className = 'improv-list';
      tips.forEach(t => {
        const li = document.createElement('li');
        li.textContent = t;
        list.appendChild(li);
      });
      improvBody.appendChild(list);
    } else {
      improvPanel.classList.add('hidden');
    }

    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- Library of saved runs -------------------------------------------------------

  function loadRecent() {
    fetch(API + '?resource=analysis')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(rows => {
        if (!rows.length) {
          recentPanel.classList.add('hidden');
          return;
        }
        recentPanel.classList.remove('hidden');
        recentList.innerHTML = '';
        rows.forEach(row => {
          const button = document.createElement('button');
          button.className = 'recent-row';

          const name = document.createElement('span');
          name.className = 'recent-row__name';
          name.textContent = row.filename;

          const meta = document.createElement('span');
          meta.className = 'recent-row__meta';
          const bits = [];
          if (row.key) bits.push(row.key);
          if (row.bpm) bits.push(`${row.bpm} BPM`);
          bits.push((row.created_at || '').slice(0, 10));
          meta.textContent = bits.join(' / ');

          button.appendChild(name);
          button.appendChild(meta);
          button.addEventListener('click', () => {
            fetch(`${API}?resource=analysis&id=${row.id}`)
              .then(r => (r.ok ? r.json() : Promise.reject()))
              .then(data => renderResults(data.filename, data.result, true))
              .catch(() => showUploadStatus('Could not load that analysis.', 'error'));
          });
          recentList.appendChild(button);
        });
      })
      .catch(() => recentPanel.classList.add('hidden'));
  }

  loadRecent();
});
