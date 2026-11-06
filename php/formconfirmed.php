<?php
/**
 * Minimal formconfirmed client: ask /v1/verify and turn the answer into a decision.
 *
 * Outage rule: anything that is not a clear answer of the service is never a pass.
 * No answer, a timeout, an HTTP error, an unknown answer, an error code that means
 * "no check took place", or a token in which the visitor's browser only *claims*
 * that the service was unreachable (reason service_unavailable) - all of these are
 * "unavailable". Such a message is delivered only if an independent check of your
 * own application passed; otherwise it is held for review.
 */

declare(strict_types=1);

const FC_FIELD = 'fcp-response';     // hidden field with the token (added by the widget)
const FC_HONEYPOT = 'fcp-website';   // trap field (added by the widget)
const FC_PURPOSE = 'contact';        // must match data-purpose of the widget
const FC_TIMEOUT = 5;                // seconds, never more

/** Error codes that mean "no check took place" (not the visitor's fault). */
const FC_NO_CHECK_CODES = ['service-disabled', 'site-paused', 'invalid-input-secret', 'missing-input-secret', 'bad-request'];

/** Settings from the environment. No secrets in the code. */
function fc_config(): array
{
    return [
        'api' => rtrim((string) (getenv('FORMCONFIRMED_API') ?: 'https://formconfirmed.com/v1'), '/'),
        'sitekey' => (string) getenv('FORMCONFIRMED_SITEKEY'),
        'secret' => (string) getenv('FORMCONFIRMED_SECRET'),
    ];
}

/**
 * Sends the token to POST /verify.
 * $fields: response, hp, remoteip and optionally email, name, content.
 */
function fc_verify(array $config, array $fields): array
{
    $body = [
        'secret' => $config['secret'],
        'response' => substr((string) ($fields['response'] ?? ''), 0, 4000),
        'hp' => substr((string) ($fields['hp'] ?? ''), 0, 2048),
        'remoteip' => (string) ($fields['remoteip'] ?? ''),
        'expected_purpose' => FC_PURPOSE,
        'form_mode' => 'interactive',
    ];
    foreach (['email', 'name', 'content'] as $k) {
        if (isset($fields[$k]) && $fields[$k] !== '') {
            $body[$k] = (string) $fields[$k];
        }
    }
    $ch = curl_init($config['api'] . '/verify');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => http_build_query($body),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => FC_TIMEOUT,
        CURLOPT_TIMEOUT => FC_TIMEOUT,
    ]);
    $answer = curl_exec($ch);
    $status = $answer === false ? 0 : (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    return fc_read_answer($status, $answer === false ? '' : (string) $answer);
}

/**
 * Turns the HTTP answer into a result: action (allow|flag|block|none), unavailable, score, reasons, codes.
 * $status 0 means "no answer" (network error or timeout).
 */
function fc_read_answer(int $status, string $body): array
{
    $none = ['action' => 'none', 'unavailable' => true, 'score' => null, 'reasons' => [],
             'codes' => [$status === 0 ? 'no-answer' : 'http-' . $status]];
    if ($status !== 200) {
        return $none;
    }
    $j = json_decode($body, true);
    if (!is_array($j) || !isset($j['action']) || !is_string($j['action'])) {
        $none['codes'] = ['invalid-answer'];
        return $none;
    }
    $codes = array_values(array_filter((array) ($j['error-codes'] ?? []), 'is_string'));
    $reasons = array_values(array_filter((array) ($j['reasons'] ?? []), 'is_string'));
    $noCheck = array_values(array_intersect($codes, FC_NO_CHECK_CODES));
    if ($noCheck) {
        $none['codes'] = $noCheck;
        return $none;
    }
    if (!in_array($j['action'], ['allow', 'flag', 'block'], true)
        || ($j['action'] === 'allow' && ($j['success'] ?? null) !== true)) {
        $none['codes'] = ['invalid-answer'];
        return $none;
    }
    return [
        'action' => $j['action'],
        // The browser could not reach the service: an unsigned claim, not a check.
        'unavailable' => $j['action'] !== 'block' && in_array('service_unavailable', $reasons, true),
        'score' => isset($j['score']) && is_numeric($j['score']) ? (float) $j['score'] : null,
        'reasons' => $reasons,
        'codes' => $codes,
    ];
}

/**
 * deliver, hold or reject.
 * $independentCheck: your own check that does not depend on formconfirmed (may stand in on an outage).
 */
function fc_decide(array $result, callable $independentCheck): string
{
    if ($result['action'] === 'block') {
        return 'reject';
    }
    if ($result['unavailable']) {
        return $independentCheck() ? 'deliver' : 'hold';
    }
    if ($result['action'] === 'flag') {
        return 'hold';   // flag is never a pass
    }
    return $result['action'] === 'allow' ? 'deliver' : 'hold';
}
