"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {requestJson, ProbeError, networkCode} = require("../scripts/monitor-http.cjs");
const endpoint = "https://dev.formconfirmed.com/v1/health";
const ok = () => new Response('{"status":"ok"}', {status:200});
function setup(responses) {
  const calls = [], waits = [], retries = [];
  return {calls, waits, retries, options: {
    fetchImpl: async (url, init) => {
      calls.push({url, init});
      const next = responses.shift();
      if (next instanceof Error) throw next;
      assert.ok(next, "unexpected extra request");
      return next;
    },
    wait: async ms => waits.push(ms), random: () => 0.5,
    onRetry: (code, attempt) => retries.push({code, attempt}),
  }};
}
test("healthy GET passes once with redirect rejection and timeout", async () => {
  const f = setup([ok()]);
  assert.deepEqual(await requestJson(endpoint, undefined, f.options), {status:"ok"});
  assert.equal(f.calls.length,1); assert.equal(f.calls[0].init.redirect,"error");
  assert.ok(f.calls[0].init.signal instanceof AbortSignal);
});
for (const status of [502,503,504]) test("transient HTTP " + status + " recovers", async () => {
  const f = setup([new Response("",{status}),ok()]);
  assert.equal((await requestJson(endpoint,undefined,f.options)).status,"ok");
  assert.deepEqual(f.retries,[{code:"http_"+status,attempt:1}]);
  assert.deepEqual(f.waits,[3000]);
});
test("connect timeout recovers on one bounded retry", async () => {
  const f = setup([
    new Error("SYNTHETIC_PRIVATE_SENTINEL",{cause:Object.assign(new Error("private"),{code:"UND_ERR_CONNECT_TIMEOUT"})}),
    ok()]);
  await requestJson(endpoint,undefined,f.options);
  assert.deepEqual(f.waits,[3000]);
  assert.deepEqual(f.retries.map(x=>x.code),["UND_ERR_CONNECT_TIMEOUT"]);
  assert.ok(!JSON.stringify(f.retries).includes("PRIVATE"));
});
test("persistent failure remains a failure after two tries", async () => {
  const f = setup([503,503].map(status=>new Response("",{status})));
  await assert.rejects(requestJson(endpoint,undefined,f.options),e=>e instanceof ProbeError && e.code==="http_503");
  assert.equal(f.calls.length,2);
});
for (const status of [401,403,404,429,500]) test("HTTP " + status + " is not hidden by retries", async () => {
  const f=setup([new Response("",{status})]);
  await assert.rejects(requestJson(endpoint,undefined,f.options),e=>e.code==="http_"+status);
  assert.equal(f.calls.length,1); assert.equal(f.waits.length,0);
});
test("one-time-token POST is never replayed",async()=>{
  const f=setup([new Response("",{status:503})]);
  await assert.rejects(requestJson(endpoint,{secret:"synthetic",response:"one-time"},f.options),e=>e.code==="http_503");
  assert.equal(f.calls.length,1); assert.equal(f.calls[0].init.method,"POST");
});
test("invalid JSON fails without retry or leaked response",async()=>{
  const f=setup([new Response("SYNTHETIC_PRIVATE_SENTINEL")]);
  await assert.rejects(requestJson(endpoint,undefined,f.options),e=>e.code==="invalid_json" && !e.message.includes("PRIVATE"));
  assert.equal(f.calls.length,1);
});
test("response is bounded while streaming",async()=>{
  const f=setup([new Response("x".repeat(16001))]);
  await assert.rejects(requestJson(endpoint,undefined,f.options),e=>e.code==="response_too_large");
  assert.equal(f.calls.length,1);
});
test("unknown and certificate errors fail closed without raw detail",async()=>{
  const f=setup([new Error("SYNTHETIC_PRIVATE_SENTINEL",{cause:{code:"CERT_HAS_EXPIRED"}})]);
  await assert.rejects(requestJson(endpoint,undefined,f.options),e=>e.code==="network_error" && !e.message.includes("PRIVATE"));
  assert.equal(f.calls.length,1);
});
test("DNS and aggregate timeout diagnoses use allowlisted codes",()=>{
  assert.equal(networkCode({cause:{code:"ENOTFOUND"}}),"ENOTFOUND");
  assert.equal(networkCode({errors:[{code:"untrusted"},{code:"ETIMEDOUT"}]}),"ETIMEDOUT");
  assert.equal(networkCode({name:"TimeoutError"}),"request_timeout");
  assert.equal(networkCode({code:"SYNTHETIC_PRIVATE_SENTINEL"}),"network_error");
});
