<?php
// Unit test of the answer handling. Run: php tests/formconfirmed_test.php
declare(strict_types=1);

require __DIR__ . '/../formconfirmed.php';

$fail = 0;
$no = fn () => false;
$yes = fn () => true;
$cases = [
    // [name, HTTP status, body, independent check, expected decision]
    ['allow', 200, '{"success":true,"score":0.9,"action":"allow","reasons":[],"error-codes":[]}', $no, 'deliver'],
    ['flag', 200, '{"success":true,"score":0.5,"action":"flag","reasons":["too_fast"],"error-codes":[]}', $no, 'hold'],
    ['flag + own check', 200, '{"success":true,"score":0.5,"action":"flag","reasons":["too_fast"]}', $yes, 'hold'],
    ['block', 200, '{"success":false,"score":0,"action":"block","reasons":[],"error-codes":["invalid-input-response"]}', $no, 'reject'],
    ['missing token', 200, '{"success":false,"score":0,"action":"block","reasons":[],"error-codes":["missing-input-response"]}', $no, 'reject'],
    ['browser outage claim', 200, '{"success":false,"score":0.35,"action":"flag","reasons":["service_unavailable"],"error-codes":["service-unavailable"]}', $no, 'hold'],
    ['outage claim + own check', 200, '{"success":false,"score":0.35,"action":"flag","reasons":["service_unavailable"]}', $yes, 'deliver'],
    ['outage claim with success', 200, '{"success":true,"score":0.5,"action":"allow","reasons":["service_unavailable"]}', $no, 'hold'],
    ['wrong secret', 200, '{"success":false,"score":0,"action":"block","reasons":[],"error-codes":["invalid-input-secret"]}', $no, 'hold'],
    ['site paused', 200, '{"success":false,"score":0,"action":"block","reasons":[],"error-codes":["site-paused"]}', $no, 'hold'],
    ['service disabled', 200, '{"success":false,"action":"block","error-codes":["service-disabled"]}', $no, 'hold'],
    ['no answer', 0, '', $no, 'hold'],
    ['no answer + own check', 0, '', $yes, 'deliver'],
    ['HTTP 500', 500, '{"success":false,"error-codes":["internal-error"]}', $no, 'hold'],
    ['HTTP 429', 429, '{"success":false,"error-codes":["rate-limited"]}', $no, 'hold'],
    ['not JSON', 200, '<html>maintenance</html>', $no, 'hold'],
    ['unknown action', 200, '{"success":true,"action":"maybe"}', $no, 'hold'],
    ['allow without success', 200, '{"success":false,"action":"allow"}', $no, 'hold'],
    ['allow with string success', 200, '{"success":"true","action":"allow"}', $no, 'hold'],
    ['JSON list', 200, '[1,2]', $no, 'hold'],
];
foreach ($cases as [$name, $status, $body, $check, $want]) {
    $got = fc_decide(fc_read_answer($status, $body), $check);
    if ($got === $want) {
        echo "ok   $name\n";
    } else {
        echo "FAIL $name: got $got, want $want\n";
        $fail++;
    }
}
echo $fail ? "$fail failed\n" : "all passed\n";
exit($fail ? 1 : 0);
