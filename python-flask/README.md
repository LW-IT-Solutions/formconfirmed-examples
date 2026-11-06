# formconfirmed - Python / Flask

Contact form with Flask 3. Python 3.9+. The verify call uses only the standard library (`urllib`).

## Start (3 commands)

```sh
cd python-flask && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
export FORMCONFIRMED_SITEKEY=fcp_pub_... FORMCONFIRMED_SECRET=fcp_sec_...
.venv/bin/python app.py
```

Open http://127.0.0.1:5000 (add `localhost` to the domains of your site for local testing).
Optional: `FORMCONFIRMED_API` (default `https://formconfirmed.com/v1`), `PORT`, `HOST`, `DATA_DIR` (default `./data`).
`app.py` uses Flask's development server; in production run it with a WSGI server (e.g. gunicorn).

## Files

- [`formconfirmed.py`](formconfirmed.py) - `verify()`, `read_answer()`, `decide()`. No dependencies; works with any framework.
- [`app.py`](app.py) - the form (`GET /`) and the server check (`POST /`).

## What happens on an outage

If formconfirmed cannot be reached within 5 seconds, answers with an HTTP error or something
unexpected, reports an error code such as `invalid-input-secret` or `site-paused`, or the visitor's
browser only claims an outage (`service_unavailable` in `reasons`), the message is **held for
review**: it is written to `data/held.jsonl` and the visitor sees "will be reviewed" (HTTP 202).
It is never delivered silently. `flag` is held, too; `block` is rejected.

Only an independent, successful check of your own application may let such a message through:
fill in `independent_check_passed()` in `app.py` (it returns `False` by default).

## Tests

```sh
.venv/bin/python -m unittest
python3 ../tests/contract_test.py -- .venv/bin/python app.py
```

Behind a reverse proxy, pass the real visitor address as `remoteip` (e.g. with `werkzeug.middleware.proxy_fix.ProxyFix`).
