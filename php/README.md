# formconfirmed - plain PHP

Contact form without a framework. PHP 8.1+ with the `curl` and `mbstring` extensions.

## Start (3 commands)

```sh
cd php
export FORMCONFIRMED_SITEKEY=fcp_pub_... FORMCONFIRMED_SECRET=fcp_sec_...
php -S 127.0.0.1:8080 -t public public/index.php
```

Open http://127.0.0.1:8080 (add `localhost` to the domains of your site for local testing).
Optional: `FORMCONFIRMED_API` (default `https://formconfirmed.com/v1`), `DATA_DIR` (default `./data`).

## Files

- [`formconfirmed.php`](formconfirmed.php) - `fc_verify()`, `fc_read_answer()`, `fc_decide()`. Copy it into your project.
- [`public/index.php`](public/index.php) - the form (`GET /`) and the server check (`POST /`).
  With Apache or nginx, point the document root to `public/` so that `data/` is not served.

## What happens on an outage

If formconfirmed cannot be reached within 5 seconds, answers with an HTTP error or something
unexpected, reports an error code such as `invalid-input-secret` or `site-paused`, or the visitor's
browser only claims an outage (`service_unavailable` in `reasons`), the message is **held for
review**: it is written to `data/held.jsonl` and the visitor sees "will be reviewed" (HTTP 202).
It is never delivered silently. `flag` is held, too; `block` is rejected.

Only an independent, successful check of your own application may let such a message through:
fill in `independent_check_passed()` in `public/index.php` (it returns `false` by default).

## Tests

```sh
php tests/formconfirmed_test.php
python3 ../tests/contract_test.py -- php -S 127.0.0.1:{port} -t public public/index.php
```

Behind a reverse proxy, pass the real visitor address as `remoteip` instead of `REMOTE_ADDR`.
