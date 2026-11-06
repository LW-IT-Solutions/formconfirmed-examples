// Minimal formconfirmed client: ask /v1/verify and turn the answer into a decision.
//
// Outage rule: anything that is not a clear answer of the service is never a pass.
// No answer, a timeout, an HTTP error, an unknown answer, an error code that means
// "no check took place", or a token in which the visitor's browser only *claims*
// that the service was unreachable (reason service_unavailable) - all of these are
// "unavailable". Such a message is delivered only if an independent check of your
// own application passed; otherwise it is held for review.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"
)

const (
	fcField    = "fcp-response" // hidden field with the token (added by the widget)
	fcHoneypot = "fcp-website"  // trap field (added by the widget)
	fcPurpose  = "contact"      // must match data-purpose of the widget
	fcTimeout  = 5 * time.Second
)

// Error codes that mean "no check took place" (not the visitor's fault).
var noCheckCodes = []string{"service-disabled", "site-paused", "invalid-input-secret", "missing-input-secret", "bad-request"}

type Config struct {
	API, Sitekey, Secret string
}

func configFromEnv() Config {
	api := os.Getenv("FORMCONFIRMED_API")
	if api == "" {
		api = "https://formconfirmed.com/v1"
	}
	return Config{
		API:     strings.TrimRight(api, "/"),
		Sitekey: os.Getenv("FORMCONFIRMED_SITEKEY"),
		Secret:  os.Getenv("FORMCONFIRMED_SECRET"),
	}
}

// Result of a check. Action is allow, flag, block or none (no clear answer).
type Result struct {
	Action      string
	Unavailable bool
	Score       *float64
	Reasons     []string
	Codes       []string
}

type VerifyInput struct {
	Response, Honeypot, RemoteIP, Email, Name, Content string
}

var httpClient = &http.Client{Timeout: fcTimeout}

func truncate(s string, n int) string {
	if len(s) > n {
		return strings.ToValidUTF8(s[:n], "")
	}
	return s
}

// Verify sends the token to POST /verify.
func Verify(cfg Config, in VerifyInput) Result {
	form := url.Values{
		"secret":           {cfg.Secret},
		"response":         {truncate(in.Response, 4000)},
		"hp":               {truncate(in.Honeypot, 2048)},
		"remoteip":         {in.RemoteIP},
		"expected_purpose": {fcPurpose},
		"form_mode":        {"interactive"},
	}
	for k, v := range map[string]string{"email": in.Email, "name": in.Name, "content": in.Content} {
		if v != "" {
			form.Set(k, v)
		}
	}
	res, err := httpClient.PostForm(cfg.API+"/verify", form)
	if err != nil {
		return ReadAnswer(0, nil) // network error or timeout
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return ReadAnswer(0, nil)
	}
	return ReadAnswer(res.StatusCode, body)
}

// ReadAnswer turns the HTTP answer into a Result. status 0 = no answer.
func ReadAnswer(status int, body []byte) Result {
	code := "no-answer"
	if status != 0 {
		code = fmt.Sprintf("http-%d", status)
	}
	none := Result{Action: "none", Unavailable: true, Reasons: []string{}, Codes: []string{code}}
	if status != 200 {
		return none
	}
	var j map[string]any
	if json.Unmarshal(body, &j) != nil || j == nil {
		none.Codes = []string{"invalid-answer"}
		return none
	}
	action, ok := j["action"].(string)
	if !ok {
		none.Codes = []string{"invalid-answer"}
		return none
	}
	codes, reasons := stringList(j["error-codes"]), stringList(j["reasons"])
	var noCheck []string
	for _, c := range codes {
		if slices.Contains(noCheckCodes, c) {
			noCheck = append(noCheck, c)
		}
	}
	if len(noCheck) > 0 {
		none.Codes = noCheck
		return none
	}
	success, _ := j["success"].(bool)
	if !slices.Contains([]string{"allow", "flag", "block"}, action) || (action == "allow" && !success) {
		none.Codes = []string{"invalid-answer"}
		return none
	}
	r := Result{
		Action: action,
		// The browser could not reach the service: an unsigned claim, not a check.
		Unavailable: action != "block" && slices.Contains(reasons, "service_unavailable"),
		Reasons:     reasons,
		Codes:       codes,
	}
	if s, ok := j["score"].(float64); ok {
		r.Score = &s
	}
	return r
}

func stringList(v any) []string {
	out := []string{}
	switch t := v.(type) {
	case string:
		out = append(out, t)
	case []any:
		for _, x := range t {
			if s, ok := x.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}

// Decide returns "deliver", "hold" or "reject". independentCheck is your own check that does not
// depend on formconfirmed.
func Decide(r Result, independentCheck func() bool) string {
	switch {
	case r.Action == "block":
		return "reject"
	case r.Unavailable:
		if independentCheck() {
			return "deliver"
		}
		return "hold"
	case r.Action == "flag":
		return "hold" // flag is never a pass
	case r.Action == "allow":
		return "deliver"
	}
	return "hold"
}
