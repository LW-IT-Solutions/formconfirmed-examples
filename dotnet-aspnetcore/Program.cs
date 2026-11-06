// Contact form protected by formconfirmed - ASP.NET Core minimal API.
// GET / shows the form with the widget, POST / checks the token on the server.
using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using FormconfirmedExample;

var host = Environment.GetEnvironmentVariable("HOST") ?? "127.0.0.1";
var port = Environment.GetEnvironmentVariable("PORT") ?? "5080";
var dataDir = Environment.GetEnvironmentVariable("DATA_DIR") ?? Path.Combine(Directory.GetCurrentDirectory(), "data");

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls($"http://{host}:{port}");
builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = 64 * 1024);
var app = builder.Build();

var fc = Formconfirmed.FromEnvironment();
var storeLock = new object();
var email = new Regex(@"^[^\s@]+@[^\s@]+\.[^\s@]+$");

string H(string s) => WebUtility.HtmlEncode(s);

IResult Page(int status, string notice = "") => Results.Content($$"""
    <!doctype html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Contact - formconfirmed ASP.NET Core example</title>
      <script src="{{H(fc.Api)}}/widget.js" async defer></script>
      <style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}label{display:block;margin:.75rem 0}input,textarea{display:block;width:100%;box-sizing:border-box}</style>
    </head>
    <body>
      <h1>Contact</h1>
      {{(notice == "" ? "" : $"<p role=\"status\">{H(notice)}</p>")}}
      <form method="post" action="/">
        <label>Name <input name="name" maxlength="60" required></label>
        <label>E-mail <input type="email" name="email" maxlength="80" required></label>
        <label>Message <textarea name="message" rows="6" maxlength="5000" required></textarea></label>
        <div class="fcp-widget" data-sitekey="{{H(fc.Sitekey)}}" data-purpose="{{H(Formconfirmed.Purpose)}}"></div>
        <button type="submit">Send</button>
      </form>
    </body>
    </html>
    """, "text/html; charset=utf-8", statusCode: status);

// Appends one message as a JSON line - stands in for sending an e-mail or a moderation queue.
void Store(string file, Dictionary<string, object?> record)
{
    var line = new Dictionary<string, object?> { ["time"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) };
    foreach (var (k, v) in record) line[k] = v;
    lock (storeLock)
    {
        Directory.CreateDirectory(dataDir);
        File.AppendAllText(Path.Combine(dataDir, file), JsonSerializer.Serialize(line) + "\n");
    }
}

// Hook for an independent check of your own application that may stand in when formconfirmed gave
// no clear answer - e.g. the visitor is logged in, or a strict CAPTCHA you already run has passed.
// It must not depend on formconfirmed. Without such a check, return false: the message is held.
bool IndependentCheckPassed(HttpContext ctx, Dictionary<string, string> form) => false;

app.MapGet("/", () => Page(200));

app.MapPost("/", async (HttpContext ctx) =>
{
    if (!ctx.Request.HasFormContentType) return Page(400, "The form could not be read.");
    var f = await ctx.Request.ReadFormAsync();
    var form = new Dictionary<string, string>
    {
        ["name"] = f["name"].ToString().Trim(),
        ["email"] = f["email"].ToString().Trim(),
        ["message"] = f["message"].ToString().Trim(),
    };
    var limits = new Dictionary<string, int> { ["name"] = 60, ["email"] = 80, ["message"] = 5000 };
    foreach (var (k, max) in limits)
    {
        var v = form[k];
        if (v == "" || v.EnumerateRunes().Count() > max)
            return Page(400, "Please fill in all fields (name up to 60, e-mail up to 80, message up to 5000 characters).");
    }
    if (!email.IsMatch(form["email"])) return Page(400, "Please enter a valid e-mail address.");

    var ip = ctx.Connection.RemoteIpAddress; // behind a proxy: the real visitor address
    var result = await fc.VerifyAsync(
        f[Formconfirmed.Field].ToString(),
        f[Formconfirmed.Honeypot].ToString(),
        ip is null ? "" : (ip.IsIPv4MappedToIPv6 ? ip.MapToIPv4() : ip).ToString(),
        form["email"], form["name"], form["message"]);

    switch (Formconfirmed.Decide(result, () => IndependentCheckPassed(ctx, form)))
    {
        case Decision.Deliver:
            // Send the e-mail here. The example writes the message to data/delivered.jsonl.
            Store("delivered.jsonl", new() { ["name"] = form["name"], ["email"] = form["email"], ["message"] = form["message"], ["score"] = result.Score });
            return Page(200, "Thank you. Your message has been sent.");
        case Decision.Hold:
            // HOLD FOR REVIEW: no clear pass (flag, or no clear answer from the service).
            // Keep the message for a human to look at - never deliver it silently.
            Store("held.jsonl", new()
            {
                ["name"] = form["name"], ["email"] = form["email"], ["message"] = form["message"],
                ["why"] = result.Unavailable ? "unavailable" : result.Action, ["codes"] = result.Codes, ["reasons"] = result.Reasons,
            });
            return Page(202, "Thank you. Your message has been received and will be reviewed before it is processed.");
        default: // reject
            return Page(403, result.Reasons.Contains("service_unavailable")
                ? "Your message could not be checked right now. Please try again in a few minutes."
                : "Your message could not be sent. Please reload the page and try again.");
    }
});

app.Run();
