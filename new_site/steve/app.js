// Simple screen manager using HTML templates to isolate state per screen
(function () {
  "use strict";

  /** Quiz data: extendable */
  const QUESTIONS = [
    {
      type: "choice",
      title: "Question 1",
      text: "When is your birthday month?",
      answers: ["January", "June", "September", "December"],
      correctIndex: 1,
    },
    {
      type: "letter",
      title: "Question 2",
      text: "Pick the first letter of the classic birthday dessert.",
      answerText: "Birthday cake", // first letter -> B
    },
    {
      type: "number",
      title: "Question 3",
      text: "How many candles for an 18th birthday?",
      correctNumber: "18",
    },
  ];

  /** Global app state kept minimal and isolated */
  let score = 0;
  let currentIndex = -1;

  const root = document.getElementById("screen-root");
  const progress = document.getElementById("progress-bar");

  function updateProgress() {
    const total = QUESTIONS.length;
    const current = Math.max(0, currentIndex + 1);
    const pct = total === 0 ? 0 : Math.min(100, Math.round((current / total) * 100));
    progress.style.width = pct + "%";
  }

  function clearRoot() {
    while (root.firstChild) root.removeChild(root.firstChild);
  }

  function instantiateTemplate(id) {
    const tmpl = document.getElementById(id);
    return tmpl.content.firstElementChild.cloneNode(true);
  }

  function mountIntro() {
    clearRoot();
    const screen = instantiateTemplate("tmpl-intro");
    screen.querySelector('[data-action="start"]').addEventListener("click", () => {
      score = 0;
      currentIndex = -1;
      nextQuestion();
    });
    root.appendChild(screen);
    updateProgress();
  }

  function mountInfo({ title, text, onNext }) {
    clearRoot();
    const screen = instantiateTemplate("tmpl-info");
    screen.querySelector(".title").textContent = title || "Info";
    screen.querySelector(".content").textContent = text || "";
    screen.querySelector('[data-action="next"]').addEventListener("click", () => {
      if (typeof onNext === "function") onNext();
    });
    root.appendChild(screen);
  }

  function mountQuestion(q) {
    clearRoot();
    if (q.type === "choice") {
      mountChoiceQuestion(q);
    } else if (q.type === "letter") {
      mountLetterQuestion(q);
    } else if (q.type === "number") {
      mountNumberQuestion(q);
    }
    updateProgress();
  }

  function mountChoiceQuestion(q) {
    const screen = instantiateTemplate("tmpl-question");
    screen.querySelector(".title").textContent = q.title;
    screen.querySelector(".question").textContent = q.text;
    const answersEl = screen.querySelector(".answers");
    const nextBtn = screen.querySelector('[data-action="next"]');
    let locked = false;

    q.answers.forEach((label, idx) => {
      const btn = document.createElement("button");
      btn.className = "answer-btn";
      btn.textContent = label;
      btn.addEventListener("click", () => {
        if (locked) return;
        locked = true;
        const correct = idx === q.correctIndex;
        if (correct) score += 1;
        [...answersEl.children].forEach((child, cIdx) => {
          child.classList.add("locked");
          if (cIdx === q.correctIndex) child.classList.add("correct");
          else if (cIdx === idx) child.classList.add("incorrect");
        });
        nextBtn.disabled = false;
      });
      answersEl.appendChild(btn);
    });

    nextBtn.addEventListener("click", nextQuestion);
    root.appendChild(screen);
  }

  function mountLetterQuestion(q) {
    const screen = instantiateTemplate("tmpl-letter");
    screen.querySelector(".title").textContent = q.title;
    screen.querySelector(".question").textContent = q.text;
    const grid = screen.querySelector(".letter-grid");
    const nextBtn = screen.querySelector('[data-action="next"]');

    const letter = (q.answerText || "").trim()[0] || "";
    const correctLetter = letter.toUpperCase();
    
    // Build 5x5 grid ordered A→Z, with top-left 'A' and bottom-right 'Z'.
    // Due to 25 cells, we include A..X and 'Z' as the last cell.
    const letters = Array.from({ length: 25 }, (_, idx) => idx < 24 ? String.fromCharCode(65 + idx) : "Z");

    let locked = false;
    letters.forEach((L) => {
      const cell = document.createElement("button");
      cell.className = "letter-cell";
      cell.textContent = L;
      cell.addEventListener("click", () => {
        if (locked) return;
        locked = true;
        const correct = L === correctLetter;
        if (correct) score += 1;
        [...grid.children].forEach((child) => {
          child.classList.add("locked");
          if (child.textContent === correctLetter) child.classList.add("correct");
        });
        if (!correct) cell.classList.add("incorrect");
        nextBtn.disabled = false;
      });
      grid.appendChild(cell);
    });

    nextBtn.addEventListener("click", nextQuestion);
    root.appendChild(screen);
  }

  function mountNumberQuestion(q) {
    const screen = instantiateTemplate("tmpl-number");
    screen.querySelector(".title").textContent = q.title;
    screen.querySelector(".question").textContent = q.text;
    const display = screen.querySelector(".num-display");
    const pad = screen.querySelector(".numpad");
    const nextBtn = screen.querySelector('[data-action="next"]');
    const feedback = screen.querySelector('.num-feedback');
    const correct = String(q.correctNumber ?? "");

    const keys = ["1","2","3","4","5","6","7","8","9","⌫","0","⏎"];
    let locked = false;
    function canSubmit() { return display.value.length > 0 && !locked; }
    keys.forEach(k => {
      const key = document.createElement("button");
      key.className = "key";
      key.textContent = k;
      key.addEventListener("click", () => {
        if (locked) return;
        if (k === "⌫") {
          display.value = display.value.slice(0, -1);
          display.classList.remove("correct", "incorrect");
          return;
        }
        if (k === "⏎") {
          if (canSubmit()) submit();
          return;
        }
        if (/^\d$/.test(k)) {
          if (display.value.length < 8) display.value += k;
        }
      });
      pad.appendChild(key);
    });

    function submit() {
      if (locked) return;
      locked = true;
      const isCorrect = display.value === correct;
      if (isCorrect) score += 1;
      display.classList.remove("correct", "incorrect");
      feedback.classList.remove("correct", "incorrect");
      feedback.classList.add(isCorrect ? "correct" : "incorrect");
      feedback.textContent = isCorrect ? "Correct!" : `Incorrect. Correct answer: ${correct}`;
      nextBtn.disabled = false;
    }

    nextBtn.addEventListener("click", nextQuestion);
    root.appendChild(screen);
  }

  function mountResult() {
    clearRoot();
    const screen = instantiateTemplate("tmpl-result");
    screen.querySelector(".score").textContent = `You got ${score}/${QUESTIONS.length} correct!`;
    screen.querySelector('[data-action="restart"]').addEventListener("click", () => {
      score = 0;
      currentIndex = -1;
      mountIntro();
    });
    root.appendChild(screen);
    updateProgress();
    launchConfetti();
  }

  function nextQuestion() {
    currentIndex += 1;
    if (currentIndex >= QUESTIONS.length) {
      mountResult();
      return;
    }
    const q = QUESTIONS[currentIndex];
    mountQuestion(q);
  }

  // Lightweight confetti
  function launchConfetti() {
    // Create a full-screen canvas attached to body
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.position = "fixed";
    canvas.style.inset = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.pointerEvents = "none";
    document.body.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    const dpi = window.devicePixelRatio || 1;

    function resize() {
      canvas.width = Math.floor(window.innerWidth * dpi);
      canvas.height = Math.floor(window.innerHeight * dpi);
    }
    resize();
    const onResize = () => resize();
    window.addEventListener("resize", onResize);

    const pieces = Array.from({ length: 180 }, () => createPiece(canvas));
    let running = true;
    const start = performance.now();

    function frame(t) {
      if (!running) return;
      const elapsed = t - start;
      if (elapsed > 3500) running = false;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let allDead = true;
      for (const p of pieces) {
        if (!p.dead) {
          updatePiece(p, canvas);
          drawPiece(ctx, p);
          if (!p.dead) allDead = false;
        }
      }
      if (running && !allDead && elapsed <= 3500) requestAnimationFrame(frame);
      else setTimeout(() => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        window.removeEventListener("resize", onResize);
        canvas.remove();
      }, 250);
    }

    requestAnimationFrame(frame);
  }

  function createPiece(canvas) {
    const dpi = window.devicePixelRatio || 1;
    const w = canvas.width, h = canvas.height;
    const colors = ["#ff5e57", "#ffd166", "#06d6a0", "#118ab2", "#ef476f", "#ffffff"];
    // Spawn only from the top for a single burst feel
    const x = Math.random() * w;
    const y = -Math.random() * 60 * dpi;
    const vx = (Math.random() - 0.5) * 4 * dpi;         // -2..2 (scaled)
    const vy = (2 + Math.random() * 5) * dpi * 0.85;   // slightly slower initial fall

    const size = 6 * dpi + Math.random() * 10 * dpi;
    return {
      x,
      y,
      size,
      color: colors[(Math.random() * colors.length) | 0],
      vx,
      vy,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,                  // slightly faster spin
      shape: Math.random() > 0.5 ? "rect" : "circle",
      dead: false,
    };
  }

  function updatePiece(p, canvas) {
    p.x += p.vx;
    p.y += p.vy;
    // Gravity (reduced a bit for slower fall)
    p.vy += 0.05 * (window.devicePixelRatio || 1) * 0.7;
    // Light horizontal damping for natural motion
    p.vx *= 0.995;
    p.rot += p.vr;
    // Stop respawning; mark as dead when out of view
    if (p.y > canvas.height + 40) p.dead = true;
  }

  function drawPiece(ctx, p) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    if (p.shape === "rect") ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
    else {
      ctx.beginPath();
      ctx.arc(0, 0, p.size * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Kickoff
  mountIntro();
})();

