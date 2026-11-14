"use strict";
// Starts the runner-local headless browser for the availability probe.
// Only this start is retried: it runs on the GitHub runner and says nothing about formconfirmed.
// Fixed diagnostic codes only: never log exception text, paths, ports or process output.
const {spawn} = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {ProbeError} = require("./monitor-http.cjs");

const CHROME_ARGS = ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--remote-debugging-port=0"];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function readEndpoint(profile) {
  let text;
  try { text = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8"); }
  catch { return null; }
  const [port, endpoint] = text.split("\n");
  if (!/^[0-9]{1,5}$/.test(port || "") || Number(port) < 1 || Number(port) > 65535) return null;
  if (!/^\/devtools\/browser\/[A-Za-z0-9-]{1,64}$/.test(endpoint || "")) return null;
  return "ws://127.0.0.1:" + port + endpoint;
}

function connectSocket(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      try { socket.close(); } catch {}
      reject(new ProbeError("browser_connection"));
    }, timeoutMs);
    socket.onopen = () => { clearTimeout(timer); resolve(socket); };
    socket.onerror = () => { clearTimeout(timer); reject(new ProbeError("browser_connection")); };
  });
}

function running(child) {
  return !!child && child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

async function stopProcess(child, wait, graceMs) {
  if (!running(child)) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  try { child.kill(); } catch {}
  await Promise.race([exited, wait(graceMs)]);
  if (!running(child)) return;
  try { child.kill("SIGKILL"); } catch {}
  await Promise.race([exited, wait(1000)]);
}

function removeProfile(profile) {
  if (!profile) return true;
  // Chrome may still flush files right after exit; retry briefly instead of failing the run.
  try { fs.rmSync(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 200}); return true; }
  catch { return false; }
}

async function launchOnce(o) {
  const profile = fs.mkdtempSync(path.join(o.tmpdir, "fc-availability-"));
  let child, socket, failure = null;
  try {
    child = o.spawnImpl(o.executable, [...CHROME_ARGS, "--user-data-dir=" + profile, "about:blank"],
      {stdio: "ignore"});
    child.on("error", () => { failure = failure || "browser_spawn"; });
    child.on("exit", () => { failure = failure || "browser_exit"; });
    const end = Date.now() + o.readyMs;
    let url;
    while (!(url = readEndpoint(profile))) {
      if (failure) throw new ProbeError(failure);
      if (Date.now() >= end) throw new ProbeError("browser_readiness");
      await o.wait(200);
    }
    try { socket = await o.connect(url, o.connectMs); }
    catch { throw new ProbeError("browser_connection"); }
    if (failure) throw new ProbeError(failure);
    return {child, profile, socket, failed: () => failure !== null};
  } catch (error) {
    if (socket) try { socket.close(); } catch {}
    await stopProcess(child, o.wait, o.graceMs);
    removeProfile(profile);
    throw error instanceof ProbeError ? error : new ProbeError("browser_start");
  }
}

async function startBrowser(options = {}) {
  const o = {executable: "/usr/bin/google-chrome", spawnImpl: spawn, connect: connectSocket, wait: pause,
    tmpdir: os.tmpdir(), readyMs: 30000, connectMs: 10000, graceMs: 5000, retryDelayMs: 1000,
    attempts: 2, onRetry: () => {}, ...options};
  for (let attempt = 1; ; attempt++) {
    try { return await launchOnce(o); }
    catch (error) {
      const code = error instanceof ProbeError ? error.code : "browser_start";
      if (attempt >= o.attempts) throw new ProbeError(code);
      o.onRetry(code, attempt);
      await o.wait(o.retryDelayMs);
    }
  }
}

async function stopBrowser(browser, options = {}) {
  if (!browser) return true;
  if (browser.socket) try { browser.socket.close(); } catch {}
  await stopProcess(browser.child, options.wait || pause, options.graceMs ?? 5000);
  return removeProfile(browser.profile);
}

module.exports = {CHROME_ARGS, readEndpoint, startBrowser, stopBrowser};
