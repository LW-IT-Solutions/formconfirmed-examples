package com.formconfirmed.example;

import static org.springframework.web.util.HtmlUtils.htmlEscape;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.json.JsonMapper;

/** Contact form: GET / shows the form with the widget, POST / checks the token on the server. */
@RestController
public class ContactController {

    private static final Pattern EMAIL = Pattern.compile("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$");
    private static final JsonMapper JSON = JsonMapper.builder().build();

    private final Formconfirmed fc = Formconfirmed.fromEnv();
    private final Path dataDir = Path.of(System.getenv().getOrDefault("DATA_DIR", "data"));

    @GetMapping("/")
    public ResponseEntity<String> show() {
        return page(200, "");
    }

    @PostMapping(value = "/", consumes = MediaType.APPLICATION_FORM_URLENCODED_VALUE)
    public ResponseEntity<String> submit(@RequestParam Map<String, String> p, HttpServletRequest request) {
        Map<String, String> form = new LinkedHashMap<>();
        for (String k : new String[] {"name", "email", "message"}) form.put(k, p.getOrDefault(k, "").strip());
        Map<String, Integer> limits = Map.of("name", 60, "email", 80, "message", 5000);
        for (var e : limits.entrySet()) {
            String v = form.get(e.getKey());
            if (v.isEmpty() || v.codePointCount(0, v.length()) > e.getValue()) {
                return page(400, "Please fill in all fields (name up to 60, e-mail up to 80, message up to 5000 characters).");
            }
        }
        if (!EMAIL.matcher(form.get("email")).matches()) return page(400, "Please enter a valid e-mail address.");

        Formconfirmed.Result result = fc.verify(
                p.getOrDefault(Formconfirmed.FIELD, ""),
                p.getOrDefault(Formconfirmed.HONEYPOT, ""),
                request.getRemoteAddr(), // behind a proxy: the real visitor address
                form.get("email"), form.get("name"), form.get("message"));

        switch (Formconfirmed.decide(result, () -> independentCheckPassed(request, form))) {
            case DELIVER -> {
                // Send the e-mail here. The example writes the message to data/delivered.jsonl.
                Map<String, Object> record = new LinkedHashMap<>(form);
                record.put("score", result.score());
                store("delivered.jsonl", record);
                return page(200, "Thank you. Your message has been sent.");
            }
            case HOLD -> {
                // HOLD FOR REVIEW: no clear pass (flag, or no clear answer from the service).
                // Keep the message for a human to look at - never deliver it silently.
                Map<String, Object> record = new LinkedHashMap<>(form);
                record.put("why", result.unavailable() ? "unavailable" : result.action());
                record.put("codes", result.codes());
                record.put("reasons", result.reasons());
                store("held.jsonl", record);
                return page(202, "Thank you. Your message has been received and will be reviewed before it is processed.");
            }
            default -> {
                return page(403, result.reasons().contains("service_unavailable")
                        ? "Your message could not be checked right now. Please try again in a few minutes."
                        : "Your message could not be sent. Please reload the page and try again.");
            }
        }
    }

    /**
     * Hook for an independent check of your own application that may stand in when formconfirmed gave
     * no clear answer - e.g. the visitor is logged in, or a strict CAPTCHA you already run has passed.
     * It must not depend on formconfirmed. Without such a check, return false: the message is held.
     */
    private boolean independentCheckPassed(HttpServletRequest request, Map<String, String> form) {
        return false;
    }

    /** Appends one message as a JSON line - stands in for sending an e-mail or a moderation queue. */
    private synchronized void store(String file, Map<String, Object> record) {
        Map<String, Object> line = new LinkedHashMap<>();
        line.put("time", Instant.now().toString());
        line.putAll(record);
        try {
            Files.createDirectories(dataDir);
            Files.writeString(dataDir.resolve(file), JSON.writeValueAsString(line) + "\n", StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private ResponseEntity<String> page(int status, String notice) {
        String html = """
                <!doctype html>
                <html lang="en">
                <head>
                  <meta charset="utf-8">
                  <meta name="viewport" content="width=device-width, initial-scale=1">
                  <title>Contact - formconfirmed Spring Boot example</title>
                  <script src="%s/widget.js" async defer></script>
                  <style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}label{display:block;margin:.75rem 0}input,textarea{display:block;width:100%%;box-sizing:border-box}</style>
                </head>
                <body>
                  <h1>Contact</h1>
                  %s
                  <form method="post" action="/">
                    <label>Name <input name="name" maxlength="60" required></label>
                    <label>E-mail <input type="email" name="email" maxlength="80" required></label>
                    <label>Message <textarea name="message" rows="6" maxlength="5000" required></textarea></label>
                    <div class="fcp-widget" data-sitekey="%s" data-purpose="%s"></div>
                    <button type="submit">Send</button>
                  </form>
                </body>
                </html>
                """.formatted(
                htmlEscape(fc.api()),
                notice.isEmpty() ? "" : "<p role=\"status\">" + htmlEscape(notice) + "</p>",
                htmlEscape(fc.sitekey()),
                htmlEscape(Formconfirmed.PURPOSE));
        return ResponseEntity.status(status).contentType(new MediaType(MediaType.TEXT_HTML, StandardCharsets.UTF_8)).body(html);
    }
}
