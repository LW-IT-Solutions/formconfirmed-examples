"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {ProbeError} = require("../scripts/monitor-http.cjs");
const {CHROME_ARGS, readEndpoint, startBrowser, stopBrowser} = require("../scripts/monitor-browser.cjs");
const ENDPOINT = "/devtools/browser/0b5e2c1a-1111-4c2d-9e3f-123456789abc";

function fakeChild(behaviour) {
  const child = new EventEmitter();
  child.pid = behaviour === "spawn_error" ? undefined : 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kills = [];
  child.kill = signal => {
    child.kills.push(signal || "SIGTERM");
    if (behaviour === "ignores_term" && !signal) return true;
    setImmediate(() => { child.signalCode = signal || "SIGTERM"; child.emit("exit", null, child.signalCode); });
    return true;
  };
  return child;
}
// Each entry describes one browser start: ready, never, exits, spawn_error, bad_port_file, ignores_term.
function setup(behaviours, connectResults = []) {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-browser-test-"));
  const spawned = [], retries = [], connects = [];
  const options = {
    executable: "/synthetic/chrome", tmpdir, readyMs: 400, connectMs: 100, graceMs: 50, retryDelayMs: 1,
    onRetry: (code, attempt) => retries.push({code, attempt}),
    spawnImpl: (executable, args, spawnOptions) => {
      const behaviour = behaviours.shift();
      assert.ok(behaviour, "unexpected extra browser start");
      const child = fakeChild(behaviour);
      const profile = args.find(arg => arg.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
      spawned.push({executable, args, spawnOptions, child, profile});
      setTimeout(() => {
        if (behaviour === "ready" || behaviour === "ignores_term")
          fs.writeFileSync(path.join(profile, "DevToolsActivePort"), "41234\n" + ENDPOINT);
        if (behaviour === "bad_port_file")
          fs.writeFileSync(path.join(profile, "DevToolsActivePort"), "SYNTHETIC_PRIVATE_SENTINEL\n/elsewhere");
        if (behaviour === "exits") { child.exitCode = 1; child.emit("exit", 1, null); }
        if (behaviour === "spawn_error") child.emit("error", new Error("SYNTHETIC_PRIVATE_SENTINEL"));
      }, 20);
      return child;
    },
    connect: async (url, timeoutMs) => {
      connects.push({url, timeoutMs});
      const next = connectResults.shift() || "open";
      if (next === "fail") throw new Error("SYNTHETIC_PRIVATE_SENTINEL");
      return {closed: false, close() { this.closed = true; }};
    },
  };
  const leftovers = () => fs.readdirSync(tmpdir);
  return {options, spawned, retries, connects, leftovers, tmpdir};
}

test("healthy browser starts once with the fixed Chrome flags", async () => {
  const f = setup(["ready"]);
  const browser = await startBrowser(f.options);
  assert.equal(f.spawned.length, 1);
  assert.equal(f.spawned[0].executable, "/synthetic/chrome");
  assert.deepEqual(f.spawned[0].args.slice(0, CHROME_ARGS.length), CHROME_ARGS);
  assert.equal(f.spawned[0].args.at(-1), "about:blank");
  assert.deepEqual(f.spawned[0].spawnOptions, {stdio: "ignore"});
  assert.deepEqual(f.connects.map(c => c.url), ["ws://127.0.0.1:41234" + ENDPOINT]);
  assert.deepEqual(f.retries, []);
  assert.equal(browser.failed(), false);
  assert.equal(await stopBrowser(browser, {graceMs: 50}), true);
  assert.equal(browser.socket.closed, true);
  assert.deepEqual(f.leftovers(), []);
});

test("readiness timeout is retried once with a fresh profile", async () => {
  const f = setup(["never", "ready"]);
  const browser = await startBrowser(f.options);
  assert.equal(f.spawned.length, 2);
  assert.notEqual(f.spawned[0].profile, f.spawned[1].profile);
  assert.deepEqual(f.spawned[0].child.kills, ["SIGTERM"]);
  assert.equal(fs.existsSync(f.spawned[0].profile), false);
  assert.deepEqual(f.retries, [{code: "browser_readiness", attempt: 1}]);
  assert.equal(await stopBrowser(browser, {graceMs: 50}), true);
  assert.deepEqual(f.leftovers(), []);
});

test("early browser exit is detected without waiting for the readiness timeout", async () => {
  const f = setup(["exits", "ready"]);
  const started = Date.now();
  const browser = await startBrowser({...f.options, readyMs: 5000});
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(f.retries, [{code: "browser_exit", attempt: 1}]);
  assert.deepEqual(f.spawned[0].child.kills, []);
  await stopBrowser(browser, {graceMs: 50});
  assert.deepEqual(f.leftovers(), []);
});

test("spawn error and connection failure are retried with fixed codes", async () => {
  for (const [behaviours, connects, code] of [
    [["spawn_error", "ready"], [], "browser_spawn"],
    [["ready", "ready"], ["fail"], "browser_connection"],
  ]) {
    const f = setup(behaviours, connects);
    const browser = await startBrowser(f.options);
    assert.deepEqual(f.retries, [{code, attempt: 1}]);
    assert.ok(!JSON.stringify(f.retries).includes("PRIVATE"));
    await stopBrowser(browser, {graceMs: 50});
    assert.deepEqual(f.leftovers(), []);
  }
});

test("a second failed start fails the run without leaking details or profiles", async () => {
  const f = setup(["never", "bad_port_file"]);
  await assert.rejects(startBrowser(f.options), error => error instanceof ProbeError
    && error.code === "browser_readiness" && !error.message.includes("PRIVATE") && !error.message.includes(f.tmpdir));
  assert.equal(f.spawned.length, 2);
  assert.equal(f.connects.length, 0);
  assert.deepEqual(f.retries, [{code: "browser_readiness", attempt: 1}]);
  assert.deepEqual(f.leftovers(), []);
});

test("a browser that ignores SIGTERM is force-stopped before its profile is removed", async () => {
  const f = setup(["ignores_term"]);
  const browser = await startBrowser(f.options);
  assert.equal(await stopBrowser(browser, {graceMs: 50}), true);
  assert.deepEqual(browser.child.kills, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(f.leftovers(), []);
});

test("only a numeric port and a DevTools browser path are accepted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-browser-port-"));
  const file = path.join(dir, "DevToolsActivePort");
  assert.equal(readEndpoint(dir), null);
  for (const text of ["", "0\n" + ENDPOINT, "70000\n" + ENDPOINT, "9222\n/json/version",
    "9222@evil.example\n" + ENDPOINT, "9222\n" + ENDPOINT + "/../x"]) {
    fs.writeFileSync(file, text);
    assert.equal(readEndpoint(dir), null, JSON.stringify(text));
  }
  fs.writeFileSync(file, "9222\n" + ENDPOINT + "\n");
  assert.equal(readEndpoint(dir), "ws://127.0.0.1:9222" + ENDPOINT);
  fs.rmSync(dir, {recursive: true, force: true});
});
