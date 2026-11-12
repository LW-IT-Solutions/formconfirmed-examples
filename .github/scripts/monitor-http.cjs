"use strict";
// Fixed diagnostic codes only: never log exception text, bodies, URLs or credentials.
const NETWORK = new Set(["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND",
  "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]);
const RETRY_NETWORK = new Set([...NETWORK].filter(code => code !== "ENOTFOUND"));
const HTTP = new Set([400,401,403,404,408,429,500,502,503,504]);
class ProbeError extends Error {
  constructor(code, retryable = false) {
    super("Availability probe failed");
    this.code = code;
    this.retryable = retryable;
  }
}
function networkCode(error, depth = 0) {
  if (!error || depth > 3) return "network_error";
  if (NETWORK.has(error.code)) return error.code;
  if (error.name === "TimeoutError") return "request_timeout";
  if (error.cause) return networkCode(error.cause, depth + 1);
  if (Array.isArray(error.errors)) {
    for (const child of error.errors.slice(0, 8)) {
      const code = networkCode(child, depth + 1);
      if (code !== "network_error") return code;
    }
  }
  return "network_error";
}
async function readJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new ProbeError("invalid_json");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16000) {
        await reader.cancel();
        throw new ProbeError("response_too_large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ProbeError("invalid_json"); }
}
async function requestJson(url, body, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const random = options.random || Math.random;
  const retry = options.onRetry || (() => {});
  // POST verifies one-time widget tokens. Never replay it automatically.
  const attempts = body === undefined ? 2 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(url, {
        redirect: "error", signal: AbortSignal.timeout(25000),
        ...(body !== undefined ? {method: "POST",
          headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)} : {}),
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new ProbeError(HTTP.has(response.status) ? "http_" + response.status : "http_other",
          [502,503,504].includes(response.status));
      }
      return await readJson(response);
    } catch (error) {
      const code = error instanceof ProbeError ? error.code : networkCode(error);
      const retryable = error instanceof ProbeError ? error.retryable :
        (RETRY_NETWORK.has(code) || code === "request_timeout");
      if (attempt === attempts || !retryable) throw new ProbeError(code);
      retry(code, attempt);
      await wait(2000 + Math.floor(random() * 2000));
    }
  }
}
module.exports = {ProbeError, networkCode, requestJson};
