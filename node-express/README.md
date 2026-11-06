# formconfirmed - Node.js / Express

Contact form with Express 5. Node.js 18+ (uses the built-in `fetch`).

## Start (3 commands)

```sh
cd node-express && npm install
export FORMCONFIRMED_SITEKEY=fcp_pub_... FORMCONFIRMED_SECRET=fcp_sec_...
npm start
```

Open http://127.0.0.1:3000 (add `localhost` to the domains of your site for local testing).
Optional: `FORMCONFIRMED_API` (default `https://formconfirmed.com/v1`), `PORT`, `HOST`, `DATA_DIR` (default `./data`).

## Files

- [`formconfirmed.js`](formconfirmed.js) - `verify()`, `readAnswer()`, `decide()`. No dependencies; copy it into your project.
- [`app.js`](app.js) - the form (`GET /`) and the server check (`POST /`).

## What happens on an outage

If formconfirmed cannot be reached within 5 seconds, answers with an HTTP error or something
unexpected, reports an error code such as `invalid-input-secret` or `site-paused`, or the visitor's
browser only claims an outage (`service_unavailable` in `reasons`), the message is **held for
review**: it is written to `data/held.jsonl` and the visitor sees "will be reviewed" (HTTP 202).
It is never delivered silently. `flag` is held, too; `block` is rejected.

Only an independent, successful check of your own application may let such a message through:
fill in `independentCheckPassed()` in `app.js` (it returns `false` by default).

## Tests

```sh
npm test
python3 ../tests/contract_test.py -- node app.js
```

Behind a reverse proxy, pass the real visitor address as `remoteip` (e.g. with `app.set('trust proxy', ...)` and `req.ip`).
