(function () {
  requireRole("admin");
  $("#logout").onclick = logout;

  let questions = [];
  let admin = null; // last state from the server

  const setMsg = (el, text, kind = "") => { el.textContent = text; el.className = "msg " + kind; };

  /* ---------- 1. read the paper ---------- */

  async function extractPdfText(file) {
    const pdfjs = window.pdfjsLib;
    pdfjs.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    let text = "";
    for (let p = 1; p <= pdf.numPages; p++) {
      const content = await (await pdf.getPage(p)).getTextContent();
      const rows = [];
      for (const it of content.items) {
        if (!it.str) continue;
        const y = Math.round(it.transform[5]);
        let row = rows.find((r) => Math.abs(r.y - y) <= 3);
        if (!row) { row = { y, items: [] }; rows.push(row); }
        row.items.push({ x: it.transform[4], s: it.str });
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) {
        r.items.sort((a, b) => a.x - b.x);
        text += r.items.map((i) => i.s).join(" ") + "\n";
      }
    }
    return text;
  }

  $("#readBtn").onclick = async () => {
    const msg = $("#readMsg");
    const file = $("#pdfFile").files[0];
    const pasted = $("#pasteText").value.trim();
    if (!file && !pasted) return setMsg(msg, "Choose a PDF or paste the questions first.", "error");
    setMsg(msg, "Reading the paper...");
    try {
      const text = file ? await extractPdfText(file) : pasted;
      const { questions: found, skipped } = parseMCQ(text);
      if (!found.length) {
        return setMsg(msg, "No questions found. Each question needs a number (1.) and options (A) B) C) D)). If the PDF is a scan made of images, paste the text instead.", "error");
      }
      questions = found;
      if (file) $("#examTitle").value = file.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ");
      renderEditor();
      setMsg(msg, `Found ${found.length} questions${skipped ? ` (skipped ${skipped} with fewer than 2 options)` : ""}. Check them in step 2.`, "ok");
    } catch (e) {
      setMsg(msg, "Couldn't read the file: " + e.message, "error");
    }
  };

  /* ---------- 2. editor ---------- */

  function renderEditor() {
    const has = questions.length > 0;
    $("#settings").hidden = !has;
    $("#editorActions").hidden = !has;
    $("#emptyEditor").hidden = has;
    $("#editor").innerHTML = questions.map((q, i) => `
      <div class="qcard" data-i="${i}">
        <div class="qhead"><strong>Question ${i + 1}</strong>
          <span class="row">
            <button class="linkbtn" data-act="clearkey" type="button">Clear answer</button>
            <button class="linkbtn danger" data-act="del" type="button">Remove</button>
          </span>
        </div>
        <textarea data-f="q" rows="2" aria-label="Question ${i + 1} text">${esc(q.q)}</textarea>
        ${q.options.map((o, k) => `
          <div class="optrow">
            <input type="radio" name="ans-${i}" data-f="ans" value="${k}" ${q.answer === k ? "checked" : ""} title="Mark ${L(k)} as the correct answer" aria-label="Correct answer is ${L(k)}">
            <span class="letter">${L(k)}</span>
            <input type="text" data-f="opt" data-k="${k}" value="${esc(o)}" aria-label="Option ${L(k)}">
            <button class="linkbtn danger" data-act="rmopt" data-k="${k}" type="button" title="Remove option">x</button>
          </div>`).join("")}
        <div class="hint">${q.answer == null ? "No correct answer marked." : "Correct answer: " + L(q.answer)}</div>
        <button class="linkbtn" data-act="addopt" type="button">Add option</button>
      </div>`).join("");
  }

  const editor = $("#editor");
  editor.addEventListener("input", (e) => {
    const card = e.target.closest(".qcard"); if (!card) return;
    const q = questions[+card.dataset.i];
    if (e.target.dataset.f === "q") q.q = e.target.value;
    if (e.target.dataset.f === "opt") q.options[+e.target.dataset.k] = e.target.value;
  });
  editor.addEventListener("change", (e) => {
    const card = e.target.closest(".qcard"); if (!card) return;
    if (e.target.dataset.f === "ans") { questions[+card.dataset.i].answer = +e.target.value; renderEditor(); }
  });
  editor.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]"); if (!btn) return;
    const i = +btn.closest(".qcard").dataset.i, q = questions[i], act = btn.dataset.act;
    if (act === "del") questions.splice(i, 1);
    if (act === "clearkey") q.answer = null;
    if (act === "addopt") { if (q.options.length >= 6) return; q.options.push(""); }
    if (act === "rmopt") {
      if (q.options.length <= 2) return;
      const k = +btn.dataset.k;
      q.options.splice(k, 1);
      if (q.answer === k) q.answer = null; else if (q.answer > k) q.answer--;
    }
    renderEditor();
  });

  $("#addQ").onclick = () => { questions.push({ q: "", options: ["", "", "", ""], answer: null }); renderEditor(); };

  $("#publishBtn").onclick = async () => {
    const msg = $("#pubMsg");
    if (!questions.length) return setMsg(msg, "Add at least one question first.", "error");
    const duration = parseInt($("#duration").value, 10);
    if (!(duration >= 1 && duration <= 600)) return setMsg(msg, "Exam length must be between 1 and 600 minutes.", "error");
    if (admin && admin.exam && (["countdown", "live"].includes(admin.exam.phase) || admin.submissions.length)) {
      if (!confirm("This replaces the current exam and clears its submissions list. Continue?")) return;
    }
    $("#publishBtn").disabled = true;
    try {
      await api("/admin/publish", { method: "POST", body: {
        title: $("#examTitle").value, duration, showResults: $("#showResults").checked, questions } });
      setMsg(msg, "Submitted. Students now see the exam on their dashboard, locked until you unlock it.", "ok");
      await refresh();
    } catch (e) { setMsg(msg, e.message, "error"); }
    $("#publishBtn").disabled = false;
  };

  /* ---------- 3. control panel ---------- */

  const badge = { locked: "Locked", countdown: "Starting soon", live: "Live", ended: "Ended" };

  function renderControl() {
    const ex = admin.exam, box = $("#control");
    if (!ex) { box.innerHTML = `<p class="muted">Nothing is published yet. Read a paper and submit it to the student dashboard.</p>`; return; }
    let buttons = "";
    if (ex.phase === "locked") buttons = `<button class="btn primary block" data-do="unlock" type="button">Unlock exam</button><p class="hint">Students see a 5-minute countdown, then the exam starts by itself.</p>`;
    if (ex.phase === "countdown") buttons = `<button class="btn block" data-do="cancel" type="button">Cancel countdown</button>`;
    if (ex.phase === "live") buttons = `<button class="btn danger block" data-do="end" type="button">End exam now</button>`;
    if (ex.phase === "ended") buttons = `<p class="hint">This exam has finished. Submit a new paper to run another.</p>`;
    box.innerHTML = `
      <p><span class="badge ${ex.phase}">${badge[ex.phase]}</span></p>
      <p class="clock-sm" id="adminClock"></p>
      <dl class="meta">
        <div><dt>Exam</dt><dd>${esc(ex.title)}</dd></div>
        <div><dt>Questions</dt><dd>${ex.total}</dd></div>
        <div><dt>Length</dt><dd>${ex.duration} min</dd></div>
        <div><dt>Answer key</dt><dd>${ex.keyed} of ${ex.total}</dd></div>
      </dl>${buttons}<p id="ctlMsg" class="msg error"></p>`;
    tick();
  }

  $("#control").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-do]"); if (!b) return;
    const what = b.dataset.do;
    if (what === "unlock" && !confirm("Unlock the exam now? Students will see a 5-minute countdown before it starts.")) return;
    if (what === "end" && !confirm("End the exam for everyone now? Students still answering will be auto-submitted.")) return;
    b.disabled = true;
    try { await api("/admin/" + what, { method: "POST" }); await refresh(); }
    catch (err) { const m = $("#ctlMsg"); if (m) m.textContent = err.message; b.disabled = false; }
  });

  function tick() {
    const el = $("#adminClock"); if (!el || !admin || !admin.exam) return;
    const ex = admin.exam, now = serverNow();
    if (ex.phase === "countdown") el.textContent = "Starts in " + fmtClock(ex.startAt - now);
    else if (ex.phase === "live") el.textContent = fmtClock(ex.endAt - now) + " left";
    else el.textContent = "";
    if ((ex.phase === "countdown" && ex.startAt <= now) || (ex.phase === "live" && ex.endAt <= now)) refresh();
  }
  setInterval(tick, 1000);

  /* ---------- submissions ---------- */

  function renderSubs() {
    const subs = admin.submissions;
    $("#subTbl").innerHTML = subs.length
      ? `<thead><tr><th>#</th><th>Name</th><th>Roll no</th><th>Answered</th><th>Score</th><th>Submitted</th><th>Emailed</th></tr></thead><tbody>${
        subs.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.name)}</td><td>${esc(s.roll)}</td><td>${s.answered}/${s.total}</td>
          <td>${s.score == null ? "-" : s.score + "/" + s.graded}</td><td>${new Date(s.submittedAt).toLocaleString()}</td>
          <td>${s.emailed ? "Yes" : `<span class="error" title="${esc(s.emailError || "")}">No${s.emailError ? ": " + esc(s.emailError) : ""}</span>`}</td></tr>`).join("")}</tbody>`
      : `<tbody><tr><td class="muted">No submissions yet.</td></tr></tbody>`;
  }

  $("#csvBtn").onclick = () => {
    if (!admin || !admin.submissions.length) return alert("There are no submissions yet.");
    const q = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
    const rows = [["Name", "Roll no", "Email", "Answered", "Total", "Score", "Graded", "Submitted at", "Emailed"]]
      .concat(admin.submissions.map((s) => [s.name, s.roll, s.email, s.answered, s.total, s.score ?? "", s.graded, new Date(s.submittedAt).toLocaleString(), s.emailed ? "yes" : "no"]));
    const blob = new Blob([rows.map((r) => r.map(q).join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "submissions.csv"; a.click();
    URL.revokeObjectURL(a.href);
  };

  async function refresh() {
    try {
      admin = await api("/admin/state");
      syncClock(admin.serverTime);
      renderControl(); renderSubs();
    } catch (e) { $("#control").innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  }
  renderEditor();
  refresh();
  setInterval(refresh, 5000);
})();
