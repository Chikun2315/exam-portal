# Online Exam Portal (Netlify)

Admin uploads a question PDF -> questions become MCQs -> admin submits them to the student dashboard (locked) -> admin clicks **Unlock** -> 5-minute countdown -> exam starts automatically -> answered questions turn green -> student submits -> answer sheet is emailed to you and the student can download a PDF copy.

## What is inside

```
netlify.toml                  Netlify settings
package.json                  2 dependencies (@netlify/blobs, nodemailer)
netlify/functions/api.js      Backend: logins, unlock timer, scoring, email
public/index.html             Login (Student / Admin)
public/admin.html             Upload PDF, edit MCQs, unlock, see submissions
public/student.html           Locked dashboard -> countdown -> exam -> answer sheet
public/js, public/css         Front-end code and styles
.env.example                  Settings you must add in Netlify
```

## 1. Set up email (Gmail example)

1. Turn on 2-Step Verification on your Google account.
2. Create an App Password (Google Account > Security > App passwords).
3. Use it as `SMTP_PASS` below. Any other SMTP provider works too.

## 2. Deploy

Drag-and-drop deploys do NOT run the backend. Use one of these:

**Option A - Netlify CLI**
```
npm install
npm install -g netlify-cli
netlify login
netlify init          # create a new site
netlify deploy --prod
```

**Option B - GitHub**: push this folder to a GitHub repo, then in Netlify choose *Add new site > Import from Git*. Publish directory `public`, no build command.

## 3. Add environment variables

Netlify > Site configuration > Environment variables. Add every value from `.env.example`
(`ADMIN_PASSWORD`, `TOKEN_SECRET`, `SMTP_*`, `MAIL_TO` are required). Then redeploy once.

## 4. Test locally (optional)

Copy `.env.example` to `.env`, fill it in, then run `netlify dev` and open http://localhost:8888

## PDF format that reads best

```
1. What is the capital of France?
A) Berlin
B) Paris
C) Rome
D) Madrid
Answer: B
```
Options can also sit on one line (`A) x B) y C) z D) w`). "Answer:" lines are optional; without them the exam still runs and the emailed sheet shows what the student chose, but no score.
Scanned PDFs (photos of pages) have no text to read: paste the text into the box instead. Always check the questions in step 2 before submitting.

## Good to know

- All students share one exam window: it starts at the same moment and ends `length` minutes later.
- One attempt per roll number. Publishing a new paper starts a fresh exam.
- Answers are saved in the browser as students go, so a refresh does not lose them.
- Time comes from the server, so changing the device clock does not help anyone.
- The correct answers never reach the student's browser during the exam.
- The PDF copy uses a standard Latin font; non-English text shows correctly in the emailed sheet but not in the downloaded PDF.
