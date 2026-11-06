# formconfirmed - .NET / ASP.NET Core

Contact form as an ASP.NET Core minimal API. .NET 10 SDK, no NuGet packages. The verify call uses
`HttpClient` and `System.Text.Json`.

## Start (3 commands)

```sh
cd dotnet-aspnetcore
export FORMCONFIRMED_SITEKEY=fcp_pub_... FORMCONFIRMED_SECRET=fcp_sec_...
dotnet run
```

Open http://127.0.0.1:5080 (add `localhost` to the domains of your site for local testing).
Optional: `FORMCONFIRMED_API` (default `https://formconfirmed.com/v1`), `PORT`, `HOST`, `DATA_DIR` (default `./data`).

## Files

- [`Formconfirmed.cs`](Formconfirmed.cs) - `VerifyAsync()`, `ReadAnswer()`, `Decide()`. Copy it into your project
  (in a real app, create it with `IHttpClientFactory`).
- [`Program.cs`](Program.cs) - the form (`GET /`) and the server check (`POST /`).

## What happens on an outage

If formconfirmed cannot be reached within 5 seconds, answers with an HTTP error or something
unexpected, reports an error code such as `invalid-input-secret` or `site-paused`, or the visitor's
browser only claims an outage (`service_unavailable` in `reasons`), the message is **held for
review**: it is written to `data/held.jsonl` and the visitor sees "will be reviewed" (HTTP 202).
It is never delivered silently. `flag` is held, too; `block` is rejected.

Only an independent, successful check of your own application may let such a message through:
fill in `IndependentCheckPassed()` in `Program.cs` (it returns `false` by default).

## Tests

```sh
dotnet build -c Release -o out
python3 ../tests/contract_test.py -- dotnet out/FormconfirmedExample.dll
```

Behind a reverse proxy, use `UseForwardedHeaders()` so that `RemoteIpAddress` is the visitor address.
