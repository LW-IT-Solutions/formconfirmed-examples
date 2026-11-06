// Unit test of the answer handling. Run: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { readAnswer, decide } = require('../formconfirmed');

const no = () => false;
const yes = () => true;
const cases = [
  // [name, HTTP status, body, independent check, expected decision]
  ['allow', 200, '{"success":true,"score":0.9,"action":"allow","reasons":[],"error-codes":[]}', no, 'deliver'],
  ['flag', 200, '{"success":true,"score":0.5,"action":"flag","reasons":["too_fast"]}', no, 'hold'],
  ['flag + own check', 200, '{"success":true,"score":0.5,"action":"flag","reasons":["too_fast"]}', yes, 'hold'],
  ['block', 200, '{"success":false,"action":"block","error-codes":["invalid-input-response"]}', no, 'reject'],
  ['browser outage claim', 200, '{"success":false,"score":0.35,"action":"flag","reasons":["service_unavailable"],"error-codes":["service-unavailable"]}', no, 'hold'],
  ['outage claim + own check', 200, '{"success":false,"action":"flag","reasons":["service_unavailable"]}', yes, 'deliver'],
  ['outage claim with success', 200, '{"success":true,"action":"allow","reasons":["service_unavailable"]}', no, 'hold'],
  ['wrong secret', 200, '{"success":false,"action":"block","error-codes":["invalid-input-secret"]}', no, 'hold'],
  ['site paused', 200, '{"success":false,"action":"block","error-codes":["site-paused"]}', no, 'hold'],
  ['no answer', 0, '', no, 'hold'],
  ['HTTP 500', 500, '{"success":false}', no, 'hold'],
  ['not JSON', 200, '<html>maintenance</html>', no, 'hold'],
  ['unknown action', 200, '{"success":true,"action":"maybe"}', no, 'hold'],
  ['allow without success', 200, '{"success":false,"action":"allow"}', no, 'hold'],
  ['allow with string success', 200, '{"success":"true","action":"allow"}', no, 'hold'],
];

for (const [name, status, body, check, want] of cases) {
  test(name, () => assert.strictEqual(decide(readAnswer(status, body), check), want));
}
