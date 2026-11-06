// Contact form protected by formconfirmed - Express.
// GET / shows the form with the widget, POST / checks the token on the server.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const fc = require('./formconfirmed');

const cfg = fc.config();
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(res, status, notice = '') {
  res.status(status).type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Contact - formconfirmed Express example</title>
  <script src="${esc(cfg.api)}/widget.js" async defer></script>
  <style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}label{display:block;margin:.75rem 0}input,textarea{display:block;width:100%;box-sizing:border-box}</style>
</head>
<body>
  <h1>Contact</h1>
  ${notice ? `<p role="status">${esc(notice)}</p>` : ''}
  <form method="post" action="/">
    <label>Name <input name="name" maxlength="60" required></label>
    <label>E-mail <input type="email" name="email" maxlength="80" required></label>
    <label>Message <textarea name="message" rows="6" maxlength="5000" required></textarea></label>
    <div class="fcp-widget" data-sitekey="${esc(cfg.sitekey)}" data-purpose="${esc(fc.PURPOSE)}"></div>
    <button type="submit">Send</button>
  </form>
</body>
</html>`);
}

// Appends one message as a JSON line - stands in for sending an e-mail or a moderation queue.
function store(file, record) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(dataDir, file), JSON.stringify({ time: new Date().toISOString(), ...record }) + '\n');
}

// Hook for an independent check of your own application that may stand in when formconfirmed gave
// no clear answer - e.g. the visitor is logged in, or a strict CAPTCHA you already run has passed.
// It must not depend on formconfirmed. Without such a check, return false: the message is held.
function independentCheckPassed(req, form) {
  return false;
}

const str = (v) => (typeof v === 'string' ? v : '');
const clientIp = (req) => (req.socket.remoteAddress || '').replace(/^::ffff:/, ''); // behind a proxy: the real visitor address

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

app.get('/', (req, res) => page(res, 200));

app.post('/', async (req, res) => {
  const b = req.body || {};
  const form = { name: str(b.name).trim(), email: str(b.email).trim(), message: str(b.message).trim() };
  const limits = { name: 60, email: 80, message: 5000 };
  for (const [k, max] of Object.entries(limits)) {
    if (!form[k] || [...form[k]].length > max) {
      return page(res, 400, 'Please fill in all fields (name up to 60, e-mail up to 80, message up to 5000 characters).');
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return page(res, 400, 'Please enter a valid e-mail address.');

  const result = await fc.verify(cfg, {
    response: str(b[fc.FIELD]),
    hp: str(b[fc.HONEYPOT]),
    remoteip: clientIp(req),
    email: form.email,
    name: form.name,
    content: form.message,
  });

  switch (fc.decide(result, () => independentCheckPassed(req, form))) {
    case 'deliver':
      // Send the e-mail here. The example writes the message to data/delivered.jsonl.
      store('delivered.jsonl', { ...form, score: result.score });
      return page(res, 200, 'Thank you. Your message has been sent.');
    case 'hold':
      // HOLD FOR REVIEW: no clear pass (flag, or no clear answer from the service).
      // Keep the message for a human to look at - never deliver it silently.
      store('held.jsonl', { ...form, why: result.unavailable ? 'unavailable' : result.action, codes: result.codes, reasons: result.reasons });
      return page(res, 202, 'Thank you. Your message has been received and will be reviewed before it is processed.');
    default: // reject
      return page(
        res,
        403,
        result.reasons.includes('service_unavailable')
          ? 'Your message could not be checked right now. Please try again in a few minutes.'
          : 'Your message could not be sent. Please reload the page and try again.',
      );
  }
});

app.listen(port, host, () => console.log(`Listening on http://${host}:${port}`));
