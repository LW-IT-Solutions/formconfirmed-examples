const {ProbeError, requestJson} = require("./monitor-http.cjs");
const {startBrowser, stopBrowser} = require("./monitor-browser.cjs");
let stage = "health";

const base = process.env.FC_MONITOR_BASE_URL || "https://formconfirmed.com";
if (!["https://formconfirmed.com", "https://dev.formconfirmed.com"].includes(base)) process.exit(2);
const secret = process.env.FC_MONITOR_SECRET;
if (!secret || !/^fcp_sec_[A-Za-z0-9_-]{32}$/.test(secret)) {
  console.error("Monitor credential is missing or invalid.");
  process.exit(2);
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, socket, session, sequence = 0;
const pending = new Map();
const checks = [];
function call(method, params = {}, attached = true) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error("browser timeout")); }, 20000);
    pending.set(id, {resolve, reject, timer});
    socket.send(JSON.stringify({id, method, params, ...(attached && session ? {sessionId: session} : {})}));
  });
}
async function until(fn) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    if (browser.failed()) throw new ProbeError("browser_exit");
    if (await fn()) return;
    await pause(200);
  }
  throw Error("browser readiness");
}
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true});
  if (result.exceptionDetails) throw Error("widget execution");
  return result.result.value;
}
async function jsonRequest(url, body) {
  return requestJson(url, body, {onRetry: (code, attempt) => {
    console.warn("RETRY stage=" + stage + " code=" + code + " attempt=" + attempt);
  }});
}
function passed(label, condition) {
  if (!condition) throw new ProbeError("check_failed");
  checks.push(label);
  console.log("PASS " + label);
}
(async () => {
  const health = await jsonRequest(base + "/v1/health");
  passed("API health", health.status === "ok");
  stage = "browser_start";
  // A runner-local browser start failure is retried once with a fresh profile; formconfirmed checks are not.
  browser = await startBrowser({executable: process.env.FC_CHROME || "/usr/bin/google-chrome",
    onRetry: (code, attempt) => console.warn("RETRY stage=" + stage + " code=" + code + " attempt=" + attempt)});
  socket = browser.socket;
  socket.onmessage = event => {
    const data = JSON.parse(event.data);
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    clearTimeout(request.timer);
    data.error ? request.reject(Error("browser command")) : request.resolve(data.result);
  };
  const target = await call("Target.createTarget", {url: "about:blank"}, false);
  session = (await call("Target.attachToTarget", {targetId: target.targetId, flatten: true}, false)).sessionId;
  await call("Page.enable");
  await call("Runtime.enable");
  stage = "widget";
  await call("Page.navigate", {url: base + "/v1/monitor"});
  await until(() => evaluate("document.readyState === 'complete' && !!document.querySelector('#availability-form') && !!window.__fcpWidget"));
  passed("Public widget loads", true);
  for (const [label, content, category, source] of [
    ["AI evaluates normal content", "Guten Tag, haben Sie nächste Woche einen Termin frei?", "ok", "ai"],
    ["Rules reject link spam", "https://offers.example https://promotion.example https://discount.example https://links.example", "links_massen", "rules"],
  ]) {
    stage = source === "ai" ? "ai_content" : "link_rules";
    const token = await evaluate("window.__fcpWidget.token(document.querySelector('#availability-form'))");
    if (typeof token !== "string" || token.length > 12000) throw Error("invalid widget token");
    // The private verification key is used only by this server process, never by the browser.
    const result = await jsonRequest(base + "/v1/verify", {secret, response: token, content, expected_purpose: "monitor"});
    passed(label, Array.isArray(result["error-codes"]) && result["error-codes"].length === 0
      && result.content?.category === category && result.checks?.content === source
      && (source !== "rules" || result.action === "block"));
    // An automated availability browser can carry automation/IP signals. Its synthetic traffic is never evidence for a normal human's allow decision.
  }
  passed("Availability check complete", checks.length === 4);
})().catch(error => {
  // Provider bodies, tokens, credentials and exception text never enter public workflow logs.
  console.error("FAIL stage=" + stage + " code=" + (error instanceof ProbeError ? error.code : "probe_error"));
  process.exitCode = 1;
}).finally(async () => {
  if (socket && socket.readyState === WebSocket.OPEN) await Promise.race([call("Browser.close", {}, false).catch(() => {}), pause(1000)]);
  // Waits for the browser to exit before removing its profile.
  if (!(await stopBrowser(browser))) {
    console.error("FAIL stage=cleanup code=profile_cleanup");
    process.exitCode = 1;
  }
});
