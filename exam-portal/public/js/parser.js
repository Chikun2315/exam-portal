/* Turns plain text (from a PDF or pasted) into MCQs.
   Expected layout:
     1. Question text
     A) option   B) option   C) option   D) option     (each on its own line, or all on one line)
     Answer: B                                          (optional)
*/
(function (root) {
  const QSTART = /^\s*(?:Q(?:uestion)?\.?\s*)?(\d{1,3})\s*[.):\-]\s*(.*)$/i;
  const OPT1 = /^\s*\(?([A-Ea-e])\)\s*(.*)$/;          // A) text   (A) text
  const OPT2 = /^\s*([A-Ea-e])[.:]\s+(.*)$/;           // A. text
  const ANS = /^\s*(?:correct\s+)?(?:ans(?:wer)?|key)\s*[:.\-)]?\s*\(?([A-Ea-e])\b/i;
  const NOISE = /^(page\s*\d+(\s*(of|\/)\s*\d+)?|\d+\s*\/\s*\d+)$/i;

  function splitInline(line) {
    const re = /(?:^|\s)\(?([A-Ea-e])[\).]\s+/g;
    const marks = [];
    let m;
    while ((m = re.exec(line))) marks.push({ letter: m[1].toUpperCase(), start: m.index, end: re.lastIndex });
    const ai = marks.findIndex((x) => x.letter === "A");
    if (ai < 0) return null;
    const run = [marks[ai]];
    for (let i = ai + 1; i < marks.length; i++) {
      const want = String.fromCharCode(run[run.length - 1].letter.charCodeAt(0) + 1);
      if (marks[i].letter === want) run.push(marks[i]);
    }
    if (run.length < 2) return null;
    return {
      pre: line.slice(0, run[0].start).trim(),
      opts: run.map((mk, i) => line.slice(mk.end, i + 1 < run.length ? run[i + 1].start : line.length).trim()),
    };
  }

  function parseMCQ(text) {
    const lines = String(text).replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l && !NOISE.test(l));
    const questions = [];
    let skipped = 0, cur = null, lastOpt = -1;

    const flush = () => {
      if (!cur) return;
      const q = cur.q.trim();
      const options = cur.options.map((o) => o.trim()).filter(Boolean);
      if (q && options.length >= 2) {
        let answer = null;
        if (cur.letter) { const i = cur.letter.charCodeAt(0) - 65; if (i >= 0 && i < options.length) answer = i; }
        questions.push({ q, options, answer });
      } else skipped++;
      cur = null; lastOpt = -1;
    };

    const feed = (line) => {
      const a = line.match(ANS);
      if (a) { cur.letter = a[1].toUpperCase(); return; }
      const inl = splitInline(line);
      if (inl) {
        if (inl.pre) cur.q += " " + inl.pre;
        inl.opts.forEach((o) => cur.options.push(o));
        lastOpt = cur.options.length - 1;
        return;
      }
      const mo = line.match(OPT1) || line.match(OPT2);
      if (mo) { cur.options.push(mo[2].trim()); lastOpt = cur.options.length - 1; return; }
      if (lastOpt >= 0) cur.options[lastOpt] += " " + line; else cur.q += " " + line;
    };

    for (const line of lines) {
      const qm = line.match(QSTART);
      if (qm) {
        flush();
        cur = { q: "", options: [], letter: null };
        if (qm[2]) feed(qm[2]);
      } else if (cur) feed(line);
    }
    flush();
    return { questions, skipped };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { parseMCQ };
  else root.parseMCQ = parseMCQ;
})(typeof window !== "undefined" ? window : globalThis);
