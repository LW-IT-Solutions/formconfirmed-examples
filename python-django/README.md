# formconfirmed - Python / Django

Contact form with Django 5.2+ in a single file (with CSRF protection). Python 3.10+.
The verify call uses only the standard library (`urllib`), the same
[`formconfirmed.py`](formconfirmed.py) as the Flask example.

## Start (3 commands)

```sh
cd python-django && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
export FORMCONFIRMED_SITEKEY=fcp_pub_... FORMCONFIRMED_SECRET=fcp_sec_...
.venv/bin/python app.py runserver 127.0.0.1:8000
```

Open http://127.0.0.1:8000 (add `localhost` to the domains of your site for local testing).
Optional: `FORMCONFIRMED_API` (default `https://formconfirmed.com/v1`), `DATA_DIR` (default `./data`),
`ALLOWED_HOSTS`, `DJANGO_SECRET_KEY`. `runserver` is for development only.

In a normal Django project, put `formconfirmed.py` next to your app and use the view `contact()`
from [`app.py`](app.py) with your own template and form class.

## What happens on an outage

If formconfirmed cannot be reached within 5 seconds, answers with an HTTP error or something
unexpected, reports an error code such as `invalid-input-secret` or `site-paused`, or the visitor's
browser only claims an outage (`service_unavailable` in `reasons`), the message is **held for
review**: it is written to `data/held.jsonl` and the visitor sees "will be reviewed" (HTTP 202).
It is never delivered silently. `flag` is held, too; `block` is rejected.

Only an independent, successful check of your own application may let such a message through:
fill in `independent_check_passed()` in `app.py` (it returns `False` by default), e.g. with
`request.user.is_authenticated`.

## Tests

```sh
.venv/bin/python -m unittest
python3 ../tests/contract_test.py -- .venv/bin/python app.py runserver --noreload 127.0.0.1:{port}
```

Behind a reverse proxy, pass the real visitor address as `remoteip` instead of `REMOTE_ADDR`.
