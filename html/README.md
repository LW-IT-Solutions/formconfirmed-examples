# Frontend snippet

[`snippet.html`](snippet.html) shows the browser side only: the widget script and the widget
element in a normal form, and a form that is sent with `fetch`.

```html
<script src="https://formconfirmed.com/v1/widget.js" async defer></script>

<form method="post" action="/contact">
  ...
  <div class="fcp-widget" data-sitekey="fcp_pub_..." data-purpose="contact"></div>
  <button type="submit">Send</button>
</form>
```

- `data-sitekey`: your site key from the dashboard (public).
- `data-purpose`: a fixed name for this form (`contact`, `login`, `register`, ...). Your server sends
  the same value as `expected_purpose`; a token for another purpose is rejected.
- The widget adds two fields to the form: `fcp-response` (the token) and `fcp-website` (a trap field
  that people never see). Send both to your server.
- For forms sent with JavaScript, call `await window.__fcpWidget.token(form, 'contact')` and send the
  result as `fcp-response`.

**The snippet alone protects nothing.** Your server must check every token with `POST /v1/verify`
before it processes the message - see the server examples in this repository. If the visitor's browser
cannot reach the service, the widget still sends a token, but it only *claims* an outage
(`service_unavailable`); the server must never treat that as a pass.
