# formconfirmed - Java / Spring Boot

Contact form with Spring Boot 4 (`spring-boot-starter-web` only). Java 21. The verify call uses the
JDK's `java.net.http.HttpClient`.

## Start (3 commands)

```sh
cd java-spring-boot && mvn -q package
export FORMCONFIRMED_SITEKEY=fcp_pub_... FORMCONFIRMED_SECRET=fcp_sec_...
java -jar target/formconfirmed-example.jar
```

Open http://127.0.0.1:8080 (add `localhost` to the domains of your site for local testing).
Optional: `FORMCONFIRMED_API` (default `https://formconfirmed.com/v1`), `PORT`, `HOST`, `DATA_DIR` (default `./data`).

## Files

- [`Formconfirmed.java`](src/main/java/com/formconfirmed/example/Formconfirmed.java) - `verify()`, `readAnswer()`, `decide()`.
- [`ContactController.java`](src/main/java/com/formconfirmed/example/ContactController.java) - the form (`GET /`) and the server check (`POST /`).

## What happens on an outage

If formconfirmed cannot be reached within 5 seconds, answers with an HTTP error or something
unexpected, reports an error code such as `invalid-input-secret` or `site-paused`, or the visitor's
browser only claims an outage (`service_unavailable` in `reasons`), the message is **held for
review**: it is written to `data/held.jsonl` and the visitor sees "will be reviewed" (HTTP 202).
It is never delivered silently. `flag` is held, too; `block` is rejected.

Only an independent, successful check of your own application may let such a message through:
fill in `independentCheckPassed()` in `ContactController.java` (it returns `false` by default).

## Tests

```sh
mvn test
python3 ../tests/contract_test.py -- java -jar target/formconfirmed-example.jar
```

Behind a reverse proxy, set `server.forward-headers-strategy` so that `getRemoteAddr()` returns the visitor address.
