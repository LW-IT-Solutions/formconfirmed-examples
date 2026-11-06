# formconfirmed examples

Small, runnable integration examples for [formconfirmed](https://formconfirmed.com), the form
protection service: one minimal contact form per web stack. Each example shows the widget in the
form (`GET /`) and checks the token on the server (`POST /`) with
[`POST /v1/verify`](https://formconfirmed.com/docs).

| Folder | Stack | Dependencies | Unit test |
|---|---|---|---|
| [`html/`](html/) | Frontend snippet only (form, fetch) | none | - |
| [`php/`](php/) | Plain PHP 8.1+, no framework | ext-curl, ext-mbstring | `php tests/formconfirmed_test.php` |
| [`node-express/`](node-express/) | Node.js 18+, Express 5 | express | `npm test` |
| [`python-flask/`](python-flask/) | Python 3.9+, Flask 3 | Flask | `python -m unittest` |
| [`python-django/`](python-django/) | Python 3.10+, Django 5.2+ (single file) | Django | `python -m unittest` |
| [`ruby-sinatra/`](ruby-sinatra/) | Ruby 3.1+, Sinatra 4 | sinatra, rackup, puma | `ruby test/formconfirmed_test.rb` |
| [`go/`](go/) | Go 1.22+, `net/http` | standard library only | `go test` |
| [`java-spring-boot/`](java-spring-boot/) | Java 21, Spring Boot 4 | spring-boot-starter-web | `mvn test` |
| [`dotnet-aspnetcore/`](dotnet-aspnetcore/) | .NET 10, ASP.NET Core minimal API | none beyond the SDK | - (contract test) |

The verify call itself only uses the standard HTTP client of each language.

## Configuration

All examples read the same environment variables. Never put the secret key into the page or the repository.

| Variable | Meaning |
|---|---|
| `FORMCONFIRMED_SITEKEY` | Site key (`fcp_pub_...`) from the dashboard - goes into the page |
| `FORMCONFIRMED_SECRET` | Secret key (`fcp_sec_...`) - stays on the server |
| `FORMCONFIRMED_API` | API base URL, default `https://formconfirmed.com/v1` (the widget is loaded from `<API>/widget.js`) |
| `HOST`, `PORT` | Where the example listens (default `127.0.0.1` and a port per example) |
| `DATA_DIR` | Where delivered and held messages are written (default `./data`) |

For local testing, add `localhost` to the domains of your site in the dashboard.

## What every example does

1. `GET /` renders a contact form with
   `<div class="fcp-widget" data-sitekey="..." data-purpose="contact">` and
   `<script src="<API>/widget.js" async defer>`. The widget adds the hidden token field
   `fcp-response` and the trap field `fcp-website`.
2. `POST /` validates the form, then sends `secret`, `response` (the token, even if empty),
   `remoteip`, `hp` (value of `fcp-website`), `expected_purpose=contact`, `form_mode=interactive`,
   `email`, `name` and `content` (the message) to `POST /v1/verify` with a timeout of 5 seconds.
3. It decides:

| Answer of the service | Decision |
|---|---|
| `action: "allow"` and `success: true` | **deliver** (the example writes `data/delivered.jsonl` - send your e-mail there) |
| `action: "flag"` | **hold for review** - flag is never a pass |
| `action: "block"` | **reject** with a neutral message |
| no clear answer (see below) | **hold for review** - or deliver, if your own independent check passed |

## Outage rule: no clear answer is never a pass

Each of these counts as "no clear answer":

- the service cannot be reached, or does not answer within 5 seconds,
- an HTTP status other than 200, or a body that is not the expected JSON,
- an unknown `action`, or `allow` without `success: true`,
- an error code that means no check took place: `invalid-input-secret`, `missing-input-secret`,
  `site-paused`, `service-disabled`, `bad-request`,
- `service_unavailable` in `reasons`: only the visitor's browser *claims* that it could not reach
  the service. That claim is not signed and proves nothing.

In all these cases the message is **not** delivered silently. The examples write it to
`data/held.jsonl` (marked with `why` and the codes) so that a human can review it - look for
`HOLD FOR REVIEW` in the code. Alternatively, show an error and ask the visitor to try again later.
A held message may only be delivered automatically after an **independent, successful check of your
own application** that does not depend on formconfirmed (for example: the visitor is logged in, or a
strict CAPTCHA you already run has passed). Every example has a hook for that
(`independent_check_passed` or similar) that returns `false` by default.

## Tests

Every example passes the same contract test, [`tests/contract_test.py`](tests/contract_test.py)
(Python 3 standard library). It starts a fake API on `127.0.0.1`, starts the example, submits the
form and checks delivered / held / rejected for allow, flag, block, missing and wrong tokens, the
browser outage claim, error codes, HTTP errors, invalid JSON, a slow API (timeout) and an
unreachable API. Example:

```sh
cd go
python3 ../tests/contract_test.py -- go run .
```

The exact command for each stack is in its README.

## Links

- Documentation: https://formconfirmed.com/docs
- WordPress: the formexposed plugin (1.8 or later) integrates formconfirmed without code.

## License

[MIT](LICENSE) - Copyright (c) 2026 LW IT Solutions
