package com.formconfirmed.example;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.BooleanSupplier;
import java.util.stream.Collectors;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Minimal formconfirmed client: ask /v1/verify and turn the answer into a decision.
 *
 * <p>Outage rule: anything that is not a clear answer of the service is never a pass.
 * No answer, a timeout, an HTTP error, an unknown answer, an error code that means
 * "no check took place", or a token in which the visitor's browser only <em>claims</em>
 * that the service was unreachable (reason service_unavailable) - all of these are
 * "unavailable". Such a message is delivered only if an independent check of your
 * own application passed; otherwise it is held for review.
 */
public final class Formconfirmed {

    public static final String FIELD = "fcp-response";   // hidden field with the token (added by the widget)
    public static final String HONEYPOT = "fcp-website"; // trap field (added by the widget)
    public static final String PURPOSE = "contact";      // must match data-purpose of the widget
    public static final Duration TIMEOUT = Duration.ofSeconds(5); // never more

    /** Error codes that mean "no check took place" (not the visitor's fault). */
    static final List<String> NO_CHECK_CODES =
            List.of("service-disabled", "site-paused", "invalid-input-secret", "missing-input-secret", "bad-request");

    public enum Decision { DELIVER, HOLD, REJECT }

    /** action is allow, flag, block or none (no clear answer). */
    public record Result(String action, boolean unavailable, Double score, List<String> reasons, List<String> codes) {
        static Result none(String code) {
            return new Result("none", true, null, List.of(), List.of(code));
        }
    }

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(TIMEOUT).build();

    private final String api;
    private final String sitekey;
    private final String secret;

    public Formconfirmed(String api, String sitekey, String secret) {
        this.api = (api == null || api.isBlank() ? "https://formconfirmed.com/v1" : api).replaceAll("/+$", "");
        this.sitekey = Objects.requireNonNullElse(sitekey, "");
        this.secret = Objects.requireNonNullElse(secret, "");
    }

    /** Settings from the environment. No secrets in the code. */
    public static Formconfirmed fromEnv() {
        return new Formconfirmed(System.getenv("FORMCONFIRMED_API"), System.getenv("FORMCONFIRMED_SITEKEY"),
                System.getenv("FORMCONFIRMED_SECRET"));
    }

    public String api() {
        return api;
    }

    public String sitekey() {
        return sitekey;
    }

    /** Sends the token to POST /verify. */
    public Result verify(String response, String hp, String remoteIp, String email, String name, String content) {
        Map<String, String> body = new LinkedHashMap<>();
        body.put("secret", secret);
        body.put("response", truncate(response, 4000));
        body.put("hp", truncate(hp, 2048));
        body.put("remoteip", Objects.requireNonNullElse(remoteIp, ""));
        body.put("expected_purpose", PURPOSE);
        body.put("form_mode", "interactive");
        if (email != null && !email.isEmpty()) body.put("email", email);
        if (name != null && !name.isEmpty()) body.put("name", name);
        if (content != null && !content.isEmpty()) body.put("content", content);
        String form = body.entrySet().stream()
                .map(e -> URLEncoder.encode(e.getKey(), StandardCharsets.UTF_8) + "=" + URLEncoder.encode(e.getValue(), StandardCharsets.UTF_8))
                .collect(Collectors.joining("&"));
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(api + "/verify"))
                    .timeout(TIMEOUT)
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .POST(HttpRequest.BodyPublishers.ofString(form))
                    .build();
            HttpResponse<String> res = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
            return readAnswer(res.statusCode(), res.body());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return readAnswer(0, "");
        } catch (Exception e) { // network error, timeout, invalid URL ...
            return readAnswer(0, "");
        }
    }

    /** Turns the HTTP answer into a Result. status 0 = no answer. */
    public static Result readAnswer(int status, String body) {
        if (status != 200) return Result.none(status == 0 ? "no-answer" : "http-" + status);
        JsonNode j;
        try {
            j = JSON.readTree(body == null ? "" : body);
        } catch (RuntimeException e) {
            j = null;
        }
        if (j == null || !j.isObject() || j.get("action") == null || !j.get("action").isString()) {
            return Result.none("invalid-answer");
        }
        String action = j.get("action").asString();
        List<String> codes = strings(j.get("error-codes"));
        List<String> reasons = strings(j.get("reasons"));
        List<String> noCheck = codes.stream().filter(NO_CHECK_CODES::contains).toList();
        if (!noCheck.isEmpty()) return new Result("none", true, null, List.of(), noCheck);
        JsonNode success = j.get("success");
        boolean successTrue = success != null && success.isBoolean() && success.booleanValue();
        if (!List.of("allow", "flag", "block").contains(action) || (action.equals("allow") && !successTrue)) {
            return Result.none("invalid-answer");
        }
        JsonNode score = j.get("score");
        return new Result(action,
                // The browser could not reach the service: an unsigned claim, not a check.
                !action.equals("block") && reasons.contains("service_unavailable"),
                score != null && score.isNumber() ? score.doubleValue() : null,
                reasons, codes);
    }

    /** independentCheck: your own check that does not depend on formconfirmed. */
    public static Decision decide(Result r, BooleanSupplier independentCheck) {
        if (r.action().equals("block")) return Decision.REJECT;
        if (r.unavailable()) return independentCheck.getAsBoolean() ? Decision.DELIVER : Decision.HOLD;
        if (r.action().equals("flag")) return Decision.HOLD; // flag is never a pass
        return r.action().equals("allow") ? Decision.DELIVER : Decision.HOLD;
    }

    private static List<String> strings(JsonNode v) {
        List<String> out = new ArrayList<>();
        if (v == null) return out;
        if (v.isString()) out.add(v.asString());
        if (v.isArray()) v.forEach(x -> { if (x.isString()) out.add(x.asString()); });
        return out;
    }

    private static String truncate(String s, int maxBytes) {
        if (s == null) return "";
        byte[] b = s.getBytes(StandardCharsets.UTF_8);
        if (b.length <= maxBytes) return s;
        String cut = new String(b, 0, maxBytes, StandardCharsets.UTF_8);
        return cut.endsWith("�") ? cut.substring(0, cut.length() - 1) : cut;
    }
}
