// Minimal formconfirmed client: ask /v1/verify and turn the answer into a decision.
//
// Outage rule: anything that is not a clear answer of the service is never a pass.
// No answer, a timeout, an HTTP error, an unknown answer, an error code that means
// "no check took place", or a token in which the visitor's browser only *claims*
// that the service was unreachable (reason service_unavailable) - all of these are
// "unavailable". Such a message is delivered only if an independent check of your
// own application passed; otherwise it is held for review.
using System.Text;
using System.Text.Json;

namespace FormconfirmedExample;

public enum Decision { Deliver, Hold, Reject }

/// <summary>Action is allow, flag, block or none (no clear answer).</summary>
public sealed record FcResult(string Action, bool Unavailable, double? Score, IReadOnlyList<string> Reasons, IReadOnlyList<string> Codes)
{
    public static FcResult None(params string[] codes) => new("none", true, null, [], codes);
}

public sealed class Formconfirmed
{
    public const string Field = "fcp-response";   // hidden field with the token (added by the widget)
    public const string Honeypot = "fcp-website"; // trap field (added by the widget)
    public const string Purpose = "contact";      // must match data-purpose of the widget
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5); // never more

    // Error codes that mean "no check took place" (not the visitor's fault).
    private static readonly string[] NoCheckCodes =
        ["service-disabled", "site-paused", "invalid-input-secret", "missing-input-secret", "bad-request"];

    private readonly HttpClient _http;

    public string Api { get; }
    public string Sitekey { get; }
    private readonly string _secret;

    public Formconfirmed(HttpClient http, string? api, string? sitekey, string? secret)
    {
        _http = http;
        _http.Timeout = Timeout;
        Api = (string.IsNullOrWhiteSpace(api) ? "https://formconfirmed.com/v1" : api).TrimEnd('/');
        Sitekey = sitekey ?? "";
        _secret = secret ?? "";
    }

    /// <summary>Settings from the environment. No secrets in the code.</summary>
    public static Formconfirmed FromEnvironment() => new(new HttpClient(),
        Environment.GetEnvironmentVariable("FORMCONFIRMED_API"),
        Environment.GetEnvironmentVariable("FORMCONFIRMED_SITEKEY"),
        Environment.GetEnvironmentVariable("FORMCONFIRMED_SECRET"));

    /// <summary>Sends the token to POST /verify.</summary>
    public async Task<FcResult> VerifyAsync(string response, string hp, string remoteIp, string email, string name, string content)
    {
        var body = new Dictionary<string, string>
        {
            ["secret"] = _secret,
            ["response"] = Truncate(response, 4000),
            ["hp"] = Truncate(hp, 2048),
            ["remoteip"] = remoteIp,
            ["expected_purpose"] = Purpose,
            ["form_mode"] = "interactive",
        };
        if (email != "") body["email"] = email;
        if (name != "") body["name"] = name;
        if (content != "") body["content"] = content;
        try
        {
            using var res = await _http.PostAsync(Api + "/verify", new FormUrlEncodedContent(body));
            return ReadAnswer((int)res.StatusCode, await res.Content.ReadAsStringAsync());
        }
        catch (Exception) // network error, timeout, invalid URL ...
        {
            return ReadAnswer(0, "");
        }
    }

    /// <summary>Turns the HTTP answer into a result. status 0 = no answer.</summary>
    public static FcResult ReadAnswer(int status, string body)
    {
        if (status != 200) return FcResult.None(status == 0 ? "no-answer" : $"http-{status}");
        JsonElement j;
        try
        {
            using var doc = JsonDocument.Parse(body);
            j = doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            return FcResult.None("invalid-answer");
        }
        if (j.ValueKind != JsonValueKind.Object || !j.TryGetProperty("action", out var a) || a.ValueKind != JsonValueKind.String)
            return FcResult.None("invalid-answer");
        var action = a.GetString()!;
        var codes = Strings(j, "error-codes");
        var reasons = Strings(j, "reasons");
        var noCheck = codes.Where(NoCheckCodes.Contains).ToArray();
        if (noCheck.Length > 0) return FcResult.None(noCheck);
        var success = j.TryGetProperty("success", out var s) && s.ValueKind == JsonValueKind.True;
        if (action is not ("allow" or "flag" or "block") || (action == "allow" && !success))
            return FcResult.None("invalid-answer");
        double? score = j.TryGetProperty("score", out var sc) && sc.ValueKind == JsonValueKind.Number ? sc.GetDouble() : null;
        // The browser could not reach the service: an unsigned claim, not a check.
        var unavailable = action != "block" && reasons.Contains("service_unavailable");
        return new FcResult(action, unavailable, score, reasons, codes);
    }

    /// <summary>independentCheck: your own check that does not depend on formconfirmed.</summary>
    public static Decision Decide(FcResult r, Func<bool> independentCheck)
    {
        if (r.Action == "block") return Decision.Reject;
        if (r.Unavailable) return independentCheck() ? Decision.Deliver : Decision.Hold;
        if (r.Action == "flag") return Decision.Hold; // flag is never a pass
        return r.Action == "allow" ? Decision.Deliver : Decision.Hold;
    }

    private static List<string> Strings(JsonElement j, string name)
    {
        var list = new List<string>();
        if (!j.TryGetProperty(name, out var v)) return list;
        if (v.ValueKind == JsonValueKind.String) list.Add(v.GetString()!);
        if (v.ValueKind == JsonValueKind.Array)
            list.AddRange(v.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!));
        return list;
    }

    private static string Truncate(string s, int maxBytes)
    {
        if (Encoding.UTF8.GetByteCount(s) <= maxBytes) return s;
        var bytes = Encoding.UTF8.GetBytes(s);
        return Encoding.UTF8.GetString(bytes, 0, maxBytes).TrimEnd('�');
    }
}
