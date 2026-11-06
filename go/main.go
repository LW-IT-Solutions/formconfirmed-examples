// Contact form protected by formconfirmed - Go, standard library only.
// GET / shows the form with the widget, POST / checks the token on the server.
package main

import (
	"encoding/json"
	"html/template"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// html/template escapes every {{.Value}} for its context.
var pageTmpl = template.Must(template.New("page").Parse(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Contact - formconfirmed Go example</title>
  <script src="{{.WidgetURL}}" async defer></script>
  <style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}label{display:block;margin:.75rem 0}input,textarea{display:block;width:100%;box-sizing:border-box}</style>
</head>
<body>
  <h1>Contact</h1>
  {{if .Notice}}<p role="status">{{.Notice}}</p>{{end}}
  <form method="post" action="/">
    <label>Name <input name="name" maxlength="60" required></label>
    <label>E-mail <input type="email" name="email" maxlength="80" required></label>
    <label>Message <textarea name="message" rows="6" maxlength="5000" required></textarea></label>
    <div class="fcp-widget" data-sitekey="{{.Sitekey}}" data-purpose="{{.Purpose}}"></div>
    <button type="submit">Send</button>
  </form>
</body>
</html>`))

var emailRe = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

type app struct {
	cfg     Config
	dataDir string
	mu      sync.Mutex
}

func (a *app) page(w http.ResponseWriter, status int, notice string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_ = pageTmpl.Execute(w, map[string]string{
		"WidgetURL": a.cfg.API + "/widget.js",
		"Sitekey":   a.cfg.Sitekey,
		"Purpose":   fcPurpose,
		"Notice":    notice,
	})
}

// store appends one message as a JSON line - stands in for sending an e-mail or a moderation queue.
func (a *app) store(file string, record map[string]any) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := os.MkdirAll(a.dataDir, 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(a.dataDir, file), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	record["time"] = time.Now().UTC().Format(time.RFC3339)
	return json.NewEncoder(f).Encode(record)
}

// independentCheckPassed is the hook for an independent check of your own application that may
// stand in when formconfirmed gave no clear answer - e.g. the visitor is logged in, or a strict
// CAPTCHA you already run has passed. It must not depend on formconfirmed. Without such a check,
// return false: the message is held.
func independentCheckPassed(r *http.Request, form map[string]string) bool {
	return false
}

func (a *app) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		a.page(w, http.StatusOK, "")
	case http.MethodPost:
		a.submit(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (a *app) submit(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := r.ParseForm(); err != nil {
		a.page(w, http.StatusBadRequest, "The form could not be read.")
		return
	}
	form := map[string]string{
		"name":    strings.TrimSpace(r.PostFormValue("name")),
		"email":   strings.TrimSpace(r.PostFormValue("email")),
		"message": strings.TrimSpace(r.PostFormValue("message")),
	}
	for k, max := range map[string]int{"name": 60, "email": 80, "message": 5000} {
		if form[k] == "" || utf8.RuneCountInString(form[k]) > max {
			a.page(w, http.StatusBadRequest, "Please fill in all fields (name up to 60, e-mail up to 80, message up to 5000 characters).")
			return
		}
	}
	if !emailRe.MatchString(form["email"]) {
		a.page(w, http.StatusBadRequest, "Please enter a valid e-mail address.")
		return
	}

	remoteIP, _, _ := net.SplitHostPort(r.RemoteAddr) // behind a proxy: the real visitor address
	result := Verify(a.cfg, VerifyInput{
		Response: r.PostFormValue(fcField),
		Honeypot: r.PostFormValue(fcHoneypot),
		RemoteIP: remoteIP,
		Email:    form["email"],
		Name:     form["name"],
		Content:  form["message"],
	})

	record := map[string]any{"name": form["name"], "email": form["email"], "message": form["message"]}
	switch Decide(result, func() bool { return independentCheckPassed(r, form) }) {
	case "deliver":
		// Send the e-mail here. The example writes the message to data/delivered.jsonl.
		record["score"] = result.Score
		if err := a.store("delivered.jsonl", record); err != nil {
			log.Print(err)
			http.Error(w, "Internal error", http.StatusInternalServerError)
			return
		}
		a.page(w, http.StatusOK, "Thank you. Your message has been sent.")
	case "hold":
		// HOLD FOR REVIEW: no clear pass (flag, or no clear answer from the service).
		// Keep the message for a human to look at - never deliver it silently.
		why := result.Action
		if result.Unavailable {
			why = "unavailable"
		}
		record["why"], record["codes"], record["reasons"] = why, result.Codes, result.Reasons
		if err := a.store("held.jsonl", record); err != nil {
			log.Print(err)
			http.Error(w, "Internal error", http.StatusInternalServerError)
			return
		}
		a.page(w, http.StatusAccepted, "Thank you. Your message has been received and will be reviewed before it is processed.")
	default: // reject
		if slices.Contains(result.Reasons, "service_unavailable") {
			a.page(w, http.StatusForbidden, "Your message could not be checked right now. Please try again in a few minutes.")
		} else {
			a.page(w, http.StatusForbidden, "Your message could not be sent. Please reload the page and try again.")
		}
	}
}

func main() {
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "data"
	}
	host, port := os.Getenv("HOST"), os.Getenv("PORT")
	if host == "" {
		host = "127.0.0.1"
	}
	if port == "" {
		port = "8080"
	}
	addr := net.JoinHostPort(host, port)
	srv := &http.Server{
		Addr:              addr,
		Handler:           &app{cfg: configFromEnv(), dataDir: dataDir},
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("Listening on http://%s", addr)
	log.Fatal(srv.ListenAndServe())
}
