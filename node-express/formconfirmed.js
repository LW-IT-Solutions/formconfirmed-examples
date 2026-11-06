// Minimal formconfirmed client: ask /v1/verify and turn the answer into a decision.
//
// Outage rule: anything that is not a clear answer of the service is never a pass.
// No answer, a timeout, an HTTP error, an unknown answer, an error code that means
// "no check took place", or a token in which the visitor's browser only *claims*
// that the service was unreachable (reason service_unavailable) - all of these are
// "unavailable". Such a message is delivered only if an independent check of your
// own application passed; otherwise it is held for review.
'use strict';

const FIELD = 'fcp-response'; // hidden field with the token (added by the widget)
const HONEYPOT = 'fcp-website'; // trap field (added by the widget)
const PURPOSE = 'contact'; // must match data-purpose of the widget
const TIMEOUT_MS = 5000; // never more

// Error codes that mean "no check took place" (not the visitor's fault).
const NO_CHECK_CODES = ['service-disabled', 'site-paused', 'invalid-input-secret', 'missing-input-secret', 'bad-request'];

function config() {
  return {
    api: (process.env.FORMCONFIRMED_API || 'https://formconfirmed.com/v1').replace(/\/+$/, ''),
    sitekey: process.env.FORMCONFIRMED_SITEKEY || '',
    secret: process.env.FORMCONFIRMED_SECRET || '',
  };
}

// fields: response, hp, remoteip and optionally email, name, content.
async function verify(cfg, fields) {
  const body = new URLSearchParams({
    secret: cfg.secret,
    response: String(fields.response || '').slice(0, 4000),
    hp: String(fields.hp || '').slice(0, 2048),
    remoteip: String(fields.remoteip || ''),
    expected_purpose: PURPOSE,
    form_mode: 'interactive',
  });
  for (const k of ['email', 'name', 'content']) {
    if (fields[k]) body.set(k, String(fields[k]));
  }
  let status = 0;
  let text = '';
  try {
    const res = await fetch(cfg.api + '/verify', { method: 'POST', body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    status = res.status;
    text = await res.text();
  } catch {
    status = 0; // network error or timeout
  }
  return readAnswer(status, text);
}

// Result: action (allow|flag|block|none), unavailable, score, reasons, codes. status 0 = no answer.
function readAnswer(status, body) {
  const none = { action: 'none', unavailable: true, score: null, reasons: [], codes: [status === 0 ? 'no-answer' : 'http-' + status] };
  if (status !== 200) return none;
  let j;
  try {
    j = JSON.parse(body);
  } catch {
    j = null;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j) || typeof j.action !== 'string') {
    return { ...none, codes: ['invalid-answer'] };
  }
  const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).filter((x) => typeof x === 'string');
  const codes = list(j['error-codes']);
  const reasons = list(j.reasons);
  const noCheck = codes.filter((c) => NO_CHECK_CODES.includes(c));
  if (noCheck.length) return { ...none, codes: noCheck };
  if (!['allow', 'flag', 'block'].includes(j.action) || (j.action === 'allow' && j.success !== true)) {
    return { ...none, codes: ['invalid-answer'] };
  }
  return {
    action: j.action,
    // The browser could not reach the service: an unsigned claim, not a check.
    unavailable: j.action !== 'block' && reasons.includes('service_unavailable'),
    score: typeof j.score === 'number' ? j.score : null,
    reasons,
    codes,
  };
}

// 'deliver', 'hold' or 'reject'. independentCheck: your own check that does not depend on formconfirmed.
function decide(result, independentCheck) {
  if (result.action === 'block') return 'reject';
  if (result.unavailable) return independentCheck() ? 'deliver' : 'hold';
  if (result.action === 'flag') return 'hold'; // flag is never a pass
  return result.action === 'allow' ? 'deliver' : 'hold';
}

module.exports = { FIELD, HONEYPOT, PURPOSE, config, verify, readAnswer, decide };
