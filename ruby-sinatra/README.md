# formconfirmed - Ruby / Sinatra

Contact form with Sinatra 4. Ruby 3.1+. The verify call uses only the standard library (`net/http`).

## Start (3 commands)

```sh
cd ruby-sinatra && bundle install
export FORMCONFIRMED_SITEKEY=fcp_pub_... FORMCONFIRMED_SECRET=fcp_sec_...
bundle exec ruby app.rb
```

Open http://127.0.0.1:4567 (add `localhost` to the domains of your site for local testing).
Optional: `FORMCONFIRMED_API` (default `https://formconfirmed.com/v1`), `PORT`, `HOST`, `DATA_DIR`
(default `./data`), `ALLOWED_HOSTS` (default `127.0.0.1,localhost`).

## Files

- [`formconfirmed.rb`](formconfirmed.rb) - `Formconfirmed.verify`, `.read_answer`, `.decide`. No gems; copy it into your project.
- [`app.rb`](app.rb) - the form (`GET /`) and the server check (`POST /`).

## What happens on an outage

If formconfirmed cannot be reached within 5 seconds, answers with an HTTP error or something
unexpected, reports an error code such as `invalid-input-secret` or `site-paused`, or the visitor's
browser only claims an outage (`service_unavailable` in `reasons`), the message is **held for
review**: it is written to `data/held.jsonl` and the visitor sees "will be reviewed" (HTTP 202).
It is never delivered silently. `flag` is held, too; `block` is rejected.

Only an independent, successful check of your own application may let such a message through:
fill in `independent_check_passed?` in `app.rb` (it returns `false` by default).

## Tests

```sh
bundle exec ruby test/formconfirmed_test.rb
python3 ../tests/contract_test.py -- bundle exec ruby app.rb
```

Behind a reverse proxy, `request.ip` returns the visitor address only if the proxy is trusted by Rack.
