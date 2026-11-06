# formconfirmed - Go

Contact form with `net/http` and `html/template`. Go 1.22+, standard library only.

## Start (3 commands)

```sh
cd go
export FORMCONFIRMED_SITEKEY=fcp_pub_... FORMCONFIRMED_SECRET=fcp_sec_...
go run .
```

Open http://127.0.0.1:8080 (add `localhost` to the domains of your site for local testing).
Optional: `FORMCONFIRMED_API` (default `https://formconfirmed.com/v1`), `PORT`, `HOST`, `DATA_DIR` (default `./data`).

## Files

- [`formconfirmed.go`](formconfirmed.go) - `Verify()`, `ReadAnswer()`, `Decide()`. Copy it into your project.
- [`main.go`](main.go) - the form (`GET /`) and the server check (`POST /`).

## What happens on an outage

If formconfirmed cannot be reached within 5 seconds, answers with an HTTP error or something
unexpected, reports an error code such as `invalid-input-secret` or `site-paused`, or the visitor's
browser only claims an outage (`service_unavailable` in `reasons`), the message is **held for
review**: it is written to `data/held.jsonl` and the visitor sees "will be reviewed" (HTTP 202).
It is never delivered silently. `flag` is held, too; `block` is rejected.

Only an independent, successful check of your own application may let such a message through:
fill in `independentCheckPassed()` in `main.go` (it returns `false` by default).

## Tests

```sh
go test
python3 ../tests/contract_test.py -- go run .
```

Behind a reverse proxy, pass the real visitor address as `RemoteIP` instead of `r.RemoteAddr`.
