(function () {
  const me = requireRole("student");
  $("#who").textContent = me.name + " (" + me.roll + ")";
  $("#logout").onclick = logout;

  const LOCK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="10.5" width="16" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>`;

  let st = null, mode = "dashboard", lastKey = "", polling = false, starting = false, submitting = false, loadingResult = false;
  let questions = [], answers = [], cur = 0, endAt = 0, examId = "", result = null;

  const views = { dashboard: $("#view-dashboard"), exam: $("#view-exam"), done: $("#view-done") };
  function show(m) {
    mode = m;
    for (const k in views) views[k].hidden = k !== m;
    $("#timerWrap").hidden = m !== "exam";
    $("#logout").hidden = m === "exam";
  }

  const saveKey = () => `exam-answers:${examId}:${me.roll}`;
  const saveAnswers = () => { try { localStorage.setItem(saveKey(), JSON.stringify(answers)); } catch {} };
  const loadAnswers = (n) => {
    try {
      const a = JSON.parse(localStorage.getItem(saveKey()) || "null");
      if (Array.isArray(a) && a.length === n) return a;
    } catch {}
    return Array(n).fill(null);
  };

  /* ---------- polling the server ---------- */

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      st = await api("/state");
      $("#net").hidden = true;
      syncClock(st.serverTime);
      route();
    } catch (e) { if (e.status !== 401) $("#net").hidden = false; }
    polling = false;
  }

  function route() {
    if (mode === "done") return;
    if (st.submitted) return loadResult();
    if (mode === "exam") {
      if (st.endAt) endAt = st.endAt; // picks up "End exam now" from the admin
      if (st.phase === "ended") submitExam(true);
      return;
    }
    if (st.phase === "live") return startExam();
    const key = st.phase + (st.examId || "");
    if (key !== lastKey) { lastKey = key; renderDash(); }
  }

  /* ---------- dashboard ---------- */

  function renderDash() {
    const p = st.phase;
    let html;
    if (p === "none") {
      html = `<div class="state"><h2>No exam yet</h2><p class="muted">Your exam hasn't been published. This page updates by itself.</p></div>`;
    } else {
      const meta = `<dl class="meta"><div><dt>Exam</dt><dd>${esc(st.title)}</dd></div><div><dt>Questions</dt><dd>${st.total}</dd></div><div><dt>Length</dt><dd>${st.duration} min</dd></div></dl>`;
      if (p === "locked") html = meta + `<div class="state">${LOCK}<h2>Locked</h2><p class="muted">The exam opens when the admin unlocks it. Keep this page open.</p></div>`;
      else if (p === "countdown") html = meta + `<div class="state"><h2>Exam starts in</h2><div class="bigclock" id="cd">--:--</div><p class="muted">Stay on this page. The first question appears by itself.</p></div>`;
      else html = meta + `<div class="state"><h2>This exam has closed</h2><p class="muted">Answers are no longer being accepted.</p></div>`;
    }
    $("#dash").innerHTML = html;
    tick();
  }

  /* ---------- exam ---------- */

  async function startExam() {
    if (starting) return;
    starting = true;
    try {
      const q = await api("/questions");
      syncClock(q.serverTime);
      questions = q.questions; endAt = q.endAt; examId = q.examId;
      answers = loadAnswers(questions.length);
      cur = 0; submitting = false;
      show("exam");
      renderExam();
    } catch (e) {
      if (e.status === 409) loadResult();
    }
    starting = false;
  }

  function renderPalette() {
    $("#palette").innerHTML = questions.map((_, i) =>
      `<button type="button" class="pal${answers[i] != null ? " done" : ""}${i === cur ? " cur" : ""}" data-i="${i}" aria-label="Question ${i + 1}${answers[i] != null ? ", answered" : ", not answered"}">${i + 1}</button>`).join("");
    const done = answers.filter((a) => a != null).length;
    $("#tally").textContent = `${done} answered, ${questions.length - done} not answered`;
  }

  function renderExam() {
    const q = questions[cur];
    $("#qpane").innerHTML = `
      <p class="muted small">Question ${cur + 1} of ${questions.length}</p>
      <div class="qtext">${esc(q.q)}</div>
      ${q.options.map((o, k) => `
        <label class="opt${answers[cur] === k ? " sel" : ""}">
          <input type="radio" name="opt" value="${k}" ${answers[cur] === k ? "checked" : ""}>
          <span class="letter">${L(k)}</span><span>${esc(o)}</span>
        </label>`).join("")}
      <div class="nav">
        <button class="btn" id="prev" type="button" ${cur === 0 ? "disabled" : ""}>Previous</button>
        <button class="btn" id="next" type="button" ${cur === questions.length - 1 ? "disabled" : ""}>Next</button>
        <span class="spacer"></span>
        <button class="btn" id="clear" type="button" ${answers[cur] == null ? "disabled" : ""}>Clear answer</button>
      </div>`;
    renderPalette();
  }

  $("#qpane").addEventListener("change", (e) => {
    if (e.target.name !== "opt") return;
    answers[cur] = +e.target.value; saveAnswers(); renderExam();
  });
  $("#qpane").addEventListener("click", (e) => {
    const id = e.target.id;
    if (id === "prev" && cur > 0) { cur--; renderExam(); }
    if (id === "next" && cur < questions.length - 1) { cur++; renderExam(); }
    if (id === "clear") { answers[cur] = null; saveAnswers(); renderExam(); }
  });
  $("#palette").addEventListener("click", (e) => {
    const b = e.target.closest(".pal"); if (!b) return;
    cur = +b.dataset.i; renderExam();
  });
  $("#submitBtn").onclick = () => submitExam(false);

  async function submitExam(auto) {
    if (submitting) return;
    if (!auto) {
      const un = answers.filter((a) => a == null).length;
      const msg = un ? `You have ${un} unanswered question${un > 1 ? "s" : ""}. Submit anyway?` : "Submit your exam now? You can't change your answers afterwards.";
      if (!confirm(msg)) return;
    }
    submitting = true;
    $("#submitBtn").disabled = true;
    try {
      result = await api("/submit", { method: "POST", body: { answers } });
      try { localStorage.removeItem(saveKey()); } catch {}
      renderDone(); show("done");
    } catch (e) {
      if (e.status === 403) {
        $("#doneBody").innerHTML = `<h1>Submission not accepted</h1><p>The exam closed before your answers reached the server. Tell your admin right away.</p>`;
        show("done");
        return;
      }
      submitting = false;
      $("#submitBtn").disabled = false;
      if (!auto) alert(e.message);
    }
  }

  function tick() {
    if (!st) return;
    if (mode === "dashboard" && st.phase === "countdown") {
      const rem = st.startAt - serverNow();
      const cd = $("#cd"); if (cd) cd.textContent = fmtClock(rem);
      if (rem <= 0) poll();
    }
    if (mode === "exam") {
      const rem = endAt - serverNow();
      $("#timer").textContent = fmtClock(rem);
      $("#timer").classList.toggle("low", rem < 5 * 60000);
      if (rem <= 0) submitExam(true);
    }
  }
  setInterval(tick, 1000);

  /* ---------- finished ---------- */

  async function loadResult() {
    if (loadingResult) return;
    loadingResult = true;
    try { result = await api("/result"); renderDone(); show("done"); } catch {}
    loadingResult = false;
  }

  function renderDone() {
    const r = result;
    $("#doneBody").innerHTML = `
      <h1>Exam submitted</h1>
      <p>Thank you, ${esc(r.name)}. Your answers are saved and the answer sheet has been sent to the examiner.</p>
      <dl class="meta">
        <div><dt>Exam</dt><dd>${esc(r.title)}</dd></div>
        <div><dt>Answered</dt><dd>${r.answered} of ${r.total}</dd></div>
        ${r.score != null ? `<div><dt>Score</dt><dd>${r.score} / ${r.graded}</dd></div>` : ""}
      </dl>
      <div class="actions">
        <button class="btn primary" id="dlPdf" type="button">Download your answer sheet (PDF)</button>
        <button class="btn" id="printBtn" type="button">Print</button>
      </div>`;
    $("#dlPdf").onclick = () => buildPdf(result);
    $("#printBtn").onclick = () => window.print();
  }

  function buildPdf(r) {
    if (!window.jspdf) return alert("The PDF tool didn't load. Check your internet connection and try again.");
    const doc = new window.jspdf.jsPDF({ unit: "pt", format: "a4" });
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 46, MW = W - M * 2;
    let y = M;
    const write = (t, { size = 10.5, bold = false, color = [17, 24, 39], indent = 0, gap = 5 } = {}) => {
      doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(size); doc.setTextColor(...color);
      for (const ln of doc.splitTextToSize(String(t), MW - indent)) {
        if (y + size > H - M) { doc.addPage(); y = M; }
        y += size; doc.text(ln, M + indent, y); y += gap;
      }
    };
    write(r.title, { size: 18, bold: true, gap: 8 });
    write(`Name: ${r.name}      Roll no: ${r.roll}`);
    write(`Submitted: ${new Date(r.submittedAt).toLocaleString()}      Answered: ${r.answered} of ${r.total}`);
    if (r.score != null) write(`Score: ${r.score} / ${r.graded}`, { bold: true });
    y += 8;
    r.rows.forEach((row, i) => {
      y += 6;
      write(`Q${i + 1}. ${row.q}`, { bold: true, gap: 6 });
      row.options.forEach((o, k) => {
        const mine = row.chosen === k;
        write(`${mine ? "[X]" : "[  ]"}  ${L(k)}) ${o}`, { indent: 14, bold: mine, color: mine ? [23, 120, 70] : [60, 70, 85] });
      });
      let note = row.chosen == null ? "Not answered" : "Your answer: " + L(row.chosen);
      if (row.correct != null) note += `      Correct answer: ${L(row.correct)}` + (row.chosen === row.correct ? "  (correct)" : "");
      write(note, { size: 9.5, indent: 14, color: [90, 100, 115], gap: 4 });
    });
    doc.save(`answer-sheet-${String(r.roll).replace(/[^a-z0-9_-]+/gi, "_")}.pdf`);
  }

  show("dashboard");
  poll();
  setInterval(poll, 3000);
})();
