import { getStore } from "@netlify/blobs";
import nodemailer from "nodemailer";
import crypto from "node:crypto";

export const config = { path: "/api/*" };

const COUNTDOWN_MS = 5 * 60 * 1000; // wait after admin clicks Unlock
const GRACE_MS = 90 * 1000; // extra time to accept auto-submits at the buzzer
const SESSION_MS = 12 * 60 * 60 * 1000;

/* ---------- small helpers ---------- */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const safeEq = (a, b) => {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

const L = (i) => String.fromCharCode(65 + i);

function secret() {
  const s = process.env.TOKEN_SECRET;
  if (!s) throw new Error("TOKEN_SECRET is not set on the server.");
  return s;
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const good = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

const endOf = (e) => e.endedAt ?? e.startAt + e.duration * 60000;

function phase(e, now) {
  if (!e) return "none";
  if (!e.startAt) return "locked";
  if (now < e.startAt) return "countdown";
  if (now < endOf(e)) return "live";
  return "ended";
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 40) || "student";
const resultKey = (examId, roll) => `result/${examId}/${slug(roll)}`;

function cleanQuestions(list) {
  if (!Array.isArray(list) || !list.length || list.length > 500) {
    throw new Error("Add at least one question (maximum 500).");
  }
  return list.map((q, i) => {
    const text = String(q.q || "").trim();
    const options = (Array.isArray(q.options) ? q.options : []).map((o) => String(o ?? "").trim());
    if (!text) throw new Error(`Question ${i + 1} has no text.`);
    if (options.length < 2 || options.length > 6 || options.some((o) => !o)) {
      throw new Error(`Question ${i + 1} needs 2 to 6 options, none empty.`);
    }
    const answer = Number.isInteger(q.answer) && q.answer >= 0 && q.answer < options.length ? q.answer : null;
    return { q: text.slice(0, 2000), options: options.map((o) => o.slice(0, 500)), answer };
  });
}

/* ---------- email ---------- */

function mailer() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) throw new Error("SMTP is not configured.");
  const port = Number(SMTP_PORT || 465);
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

function sheetHtml(exam, r, includeKey) {
  const tz = process.env.TIMEZONE || "Asia/Kolkata";
  const when = new Date(r.submittedAt).toLocaleString("en-IN", { timeZone: tz });
  const keyed = includeKey && r.graded > 0;
  const rows = exam.questions
    .map((q, i) => {
      const chosen = r.answers[i];
      const mine = chosen == null ? "<em>Not answered</em>" : `${L(chosen)}) ${esc(q.options[chosen])}`;
      let key = "";
      let mark = "";
      if (keyed) {
        key = `<td style="padding:6px;border:1px solid #ccc">${q.answer == null ? "-" : `${L(q.answer)}) ${esc(q.options[q.answer])}`}</td>`;
        mark = `<td style="padding:6px;border:1px solid #ccc;text-align:center">${
          q.answer == null ? "-" : chosen === q.answer ? "&#10003;" : "&#10007;"
        }</td>`;
      }
      return `<tr>
        <td style="padding:6px;border:1px solid #ccc;text-align:center">${i + 1}</td>
        <td style="padding:6px;border:1px solid #ccc">${esc(q.q)}</td>
        <td style="padding:6px;border:1px solid #ccc">${mine}</td>${key}${mark}</tr>`;
    })
    .join("");
  const head = ["#", "Question", "Student's answer", ...(keyed ? ["Correct answer", "Result"] : [])]
    .map((h) => `<th style="padding:6px;border:1px solid #ccc;background:#f0f2f6;text-align:left">${h}</th>`)
    .join("");
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">
    <h2 style="margin:0 0 8px">${esc(exam.title)} - answer sheet</h2>
    <p style="margin:0 0 12px">
      <b>Name:</b> ${esc(r.name)}<br><b>Roll no:</b> ${esc(r.roll)}<br>
      ${r.email ? `<b>Email:</b> ${esc(r.email)}<br>` : ""}
      <b>Submitted:</b> ${esc(when)}<br>
      <b>Answered:</b> ${r.answered} of ${r.total}
      ${keyed ? `<br><b>Score:</b> ${r.score} / ${r.graded}` : ""}
    </p>
    <table style="border-collapse:collapse;width:100%"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>
  </div>`;
}

async function sendSheet(exam, r) {
  const t = mailer();
  const to = process.env.MAIL_TO;
  if (!to) throw new Error("MAIL_TO is not set.");
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const html = sheetHtml(exam, r, true);
  await t.sendMail({
    from,
    to,
    subject: `Answer sheet: ${r.name} (${r.roll}) - ${exam.title}`,
    html,
    attachments: [{ filename: `answer-sheet-${slug(r.roll)}.html`, content: html, contentType: "text/html" }],
  });
  if (r.email) {
    try {
      await t.sendMail({
        from,
        to: r.email,
        subject: `Your answer sheet - ${exam.title}`,
        html: sheetHtml(exam, r, exam.showResults),
      });
    } catch {
      /* the student copy is best-effort */
    }
  }
}

/* ---------- shapes sent to the browser ---------- */

function publicResult(r, exam) {
  const show = !!exam.showResults;
  return {
    name: r.name,
    roll: r.roll,
    title: exam.title,
    submittedAt: r.submittedAt,
    answered: r.answered,
    total: r.total,
    graded: show ? r.graded : 0,
    score: show && r.graded > 0 ? r.score : null,
    rows: exam.questions.map((q, i) => ({
      q: q.q,
      options: q.options,
      chosen: r.answers[i],
      correct: show ? q.answer : null,
    })),
  };
}

const examMeta = (e, now) => ({
  id: e.id,
  title: e.title,
  duration: e.duration,
  total: e.questions.length,
  keyed: e.questions.filter((q) => q.answer != null).length,
  showResults: !!e.showResults,
  phase: phase(e, now),
  startAt: e.startAt || null,
  endAt: e.startAt ? endOf(e) : null,
  createdAt: e.createdAt,
});

/* ---------- handler ---------- */

export default async (req) => {
  try {
    const url = new URL(req.url);
    const route = url.pathname.replace(/^\/api/, "") || "/";
    const method = req.method;
    const now = Date.now();
    let body = {};
    if (method === "POST") {
      try {
        body = await req.json();
      } catch {
        body = {};
      }
    }

    /* ----- login ----- */
    if (route === "/login" && method === "POST") {
      if (body.role === "admin") {
        const u = process.env.ADMIN_USERNAME || "admin";
        const p = process.env.ADMIN_PASSWORD;
        if (!p) return json({ error: "ADMIN_PASSWORD is not set on the server." }, 500);
        if (!safeEq(body.username || "", u) || !safeEq(body.password || "", p)) {
          return json({ error: "Wrong admin username or password." }, 401);
        }
        return json({ token: sign({ role: "admin", exp: now + SESSION_MS }), role: "admin" });
      }
      if (body.role === "student") {
        const code = process.env.STUDENT_ACCESS_CODE;
        if (code && !safeEq(body.code || "", code)) return json({ error: "Wrong access code." }, 401);
        const name = String(body.name || "").trim().slice(0, 80);
        const roll = String(body.roll || "").trim().slice(0, 40);
        const email = String(body.email || "").trim().slice(0, 120);
        if (!name || !roll) return json({ error: "Enter your name and roll number." }, 400);
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "That email address doesn't look right." }, 400);
        return json({ token: sign({ role: "student", name, roll, email, exp: now + SESSION_MS }), role: "student", name, roll });
      }
      return json({ error: "Choose student or admin." }, 400);
    }

    const auth = verify((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
    if (!auth) return json({ error: "Please sign in again." }, 401);

    const s = getStore({ name: "exam-portal", consistency: "strong" });
    const exam = await s.get("exam", { type: "json" });

    /* ----- admin ----- */
    if (route.startsWith("/admin/")) {
      if (auth.role !== "admin") return json({ error: "Admins only." }, 403);

      if (route === "/admin/state" && method === "GET") {
        let submissions = [];
        if (exam) {
          const { blobs } = await s.list({ prefix: `result/${exam.id}/` });
          const items = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
          submissions = items
            .filter(Boolean)
            .sort((a, b) => a.submittedAt - b.submittedAt)
            .map((r) => ({
              name: r.name,
              roll: r.roll,
              email: r.email,
              answered: r.answered,
              total: r.total,
              score: r.graded > 0 ? r.score : null,
              graded: r.graded,
              submittedAt: r.submittedAt,
              emailed: r.emailed,
              emailError: r.emailError,
            }));
        }
        return json({ serverTime: now, exam: exam ? examMeta(exam, now) : null, submissions });
      }

      if (route === "/admin/publish" && method === "POST") {
        const questions = cleanQuestions(body.questions);
        const duration = Math.round(Number(body.duration));
        if (!(duration >= 1 && duration <= 600)) return json({ error: "Duration must be between 1 and 600 minutes." }, 400);
        const next = {
          id: crypto.randomUUID(),
          title: String(body.title || "Online exam").trim().slice(0, 120) || "Online exam",
          duration,
          showResults: !!body.showResults,
          questions,
          startAt: null,
          endedAt: null,
          createdAt: now,
        };
        await s.setJSON("exam", next);
        return json({ ok: true, exam: examMeta(next, now) });
      }

      if (!exam) return json({ error: "Publish an exam first." }, 400);

      if (route === "/admin/unlock" && method === "POST") {
        const ph = phase(exam, now);
        if (ph !== "locked") return json({ error: ph === "ended" ? "This exam has finished. Publish a new paper to run it again." : "The exam is already unlocked." }, 409);
        exam.startAt = now + COUNTDOWN_MS;
        exam.endedAt = null;
        await s.setJSON("exam", exam);
        return json({ ok: true, exam: examMeta(exam, now) });
      }

      if (route === "/admin/cancel" && method === "POST") {
        if (phase(exam, now) !== "countdown") return json({ error: "There is no countdown to cancel." }, 409);
        exam.startAt = null;
        await s.setJSON("exam", exam);
        return json({ ok: true, exam: examMeta(exam, now) });
      }

      if (route === "/admin/end" && method === "POST") {
        if (phase(exam, now) !== "live") return json({ error: "The exam isn't running." }, 409);
        exam.endedAt = now;
        await s.setJSON("exam", exam);
        return json({ ok: true, exam: examMeta(exam, now) });
      }

      return json({ error: "Not found." }, 404);
    }

    /* ----- student ----- */
    if (auth.role !== "student") return json({ error: "Students only." }, 403);

    if (route === "/state" && method === "GET") {
      if (!exam) return json({ phase: "none", serverTime: now, submitted: false });
      const meta = examMeta(exam, now);
      const done = await s.get(resultKey(exam.id, auth.roll), { type: "json" });
      const reveal = meta.phase !== "locked";
      return json({
        serverTime: now,
        phase: meta.phase,
        examId: exam.id,
        title: meta.title,
        duration: meta.duration,
        total: meta.total,
        startAt: reveal ? meta.startAt : null,
        endAt: reveal ? meta.endAt : null,
        submitted: !!done,
      });
    }

    if (route === "/questions" && method === "GET") {
      if (!exam) return json({ error: "No exam yet." }, 404);
      const done = await s.get(resultKey(exam.id, auth.roll), { type: "json" });
      if (done) return json({ error: "You have already submitted this exam." }, 409);
      if (phase(exam, now) !== "live") return json({ error: "The exam is not open." }, 403);
      return json({
        serverTime: now,
        examId: exam.id,
        title: exam.title,
        endAt: endOf(exam),
        questions: exam.questions.map((q) => ({ q: q.q, options: q.options })),
      });
    }

    if (route === "/result" && method === "GET") {
      if (!exam) return json({ error: "No exam yet." }, 404);
      const done = await s.get(resultKey(exam.id, auth.roll), { type: "json" });
      if (!done) return json({ error: "No submission found." }, 404);
      return json(publicResult(done, exam));
    }

    if (route === "/submit" && method === "POST") {
      if (!exam) return json({ error: "No exam yet." }, 404);
      const key = resultKey(exam.id, auth.roll);
      const existing = await s.get(key, { type: "json" });
      if (existing) return json(publicResult(existing, exam));

      const open = exam.startAt && now >= exam.startAt && now <= endOf(exam) + GRACE_MS;
      if (!open) return json({ error: "The exam is not accepting answers." }, 403);

      const raw = Array.isArray(body.answers) ? body.answers : [];
      const answers = exam.questions.map((q, i) => (Number.isInteger(raw[i]) && raw[i] >= 0 && raw[i] < q.options.length ? raw[i] : null));
      const graded = exam.questions.filter((q) => q.answer != null).length;
      const score = exam.questions.reduce((n, q, i) => n + (q.answer != null && answers[i] === q.answer ? 1 : 0), 0);

      const r = {
        name: auth.name,
        roll: auth.roll,
        email: auth.email || "",
        examId: exam.id,
        answers,
        answered: answers.filter((a) => a !== null).length,
        total: exam.questions.length,
        graded,
        score,
        submittedAt: now,
        emailed: false,
        emailError: null,
      };
      await s.setJSON(key, r); // save first so nothing is lost if email is slow

      try {
        await sendSheet(exam, r);
        r.emailed = true;
      } catch (e) {
        r.emailError = String(e.message || e).slice(0, 200);
      }
      await s.setJSON(key, r);
      return json(publicResult(r, exam));
    }

    return json({ error: "Not found." }, 404);
  } catch (e) {
    return json({ error: e.message || "Server error." }, 500);
  }
};
