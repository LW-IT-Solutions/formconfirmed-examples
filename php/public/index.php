<?php
/**
 * Contact form protected by formconfirmed - plain PHP, no framework.
 * GET / shows the form with the widget, POST / checks the token on the server.
 */

declare(strict_types=1);

require __DIR__ . '/../formconfirmed.php';

$config = fc_config();
$dataDir = (string) (getenv('DATA_DIR') ?: __DIR__ . '/../data');   // outside the web root

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
if ($path !== '/') {
    http_response_code(404);
    exit('Not found');
}

function h(string $s): string
{
    return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function page(int $status, array $config, string $notice = ''): never
{
    http_response_code($status);
    header('Content-Type: text/html; charset=utf-8');
    $api = h($config['api']);
    $sitekey = h($config['sitekey']);
    $purpose = h(FC_PURPOSE);
    $notice = $notice !== '' ? '<p role="status">' . h($notice) . '</p>' : '';
    echo <<<HTML
    <!doctype html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Contact - formconfirmed PHP example</title>
      <script src="{$api}/widget.js" async defer></script>
      <style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}label{display:block;margin:.75rem 0}input,textarea{display:block;width:100%;box-sizing:border-box}</style>
    </head>
    <body>
      <h1>Contact</h1>
      {$notice}
      <form method="post" action="/">
        <label>Name <input name="name" maxlength="60" required></label>
        <label>E-mail <input type="email" name="email" maxlength="80" required></label>
        <label>Message <textarea name="message" rows="6" maxlength="5000" required></textarea></label>
        <div class="fcp-widget" data-sitekey="{$sitekey}" data-purpose="{$purpose}"></div>
        <button type="submit">Send</button>
      </form>
    </body>
    </html>
    HTML;
    exit;
}

/** Appends one message as a JSON line - stands in for sending an e-mail or a moderation queue. */
function store(string $dir, string $file, array $record): void
{
    if (!is_dir($dir)) {
        mkdir($dir, 0700, true);
    }
    $record = ['time' => gmdate('c')] + $record;
    file_put_contents($dir . '/' . $file, json_encode($record, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n", FILE_APPEND | LOCK_EX);
}

/**
 * Hook for an independent check of your own application that may stand in when formconfirmed gave
 * no clear answer - e.g. the visitor is logged in, or a strict CAPTCHA you already run has passed.
 * It must not depend on formconfirmed. Without such a check, return false: the message is held.
 */
function independent_check_passed(array $form): bool
{
    return false;
}

function posted(string $name): string
{
    $v = $_POST[$name] ?? '';
    return is_string($v) ? $v : '';
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'GET' || $method === 'HEAD') {
    page(200, $config);
}
if ($method !== 'POST') {
    header('Allow: GET, POST');
    http_response_code(405);
    exit;
}

$form = ['name' => trim(posted('name')), 'email' => trim(posted('email')), 'message' => trim(posted('message'))];
$limits = ['name' => 60, 'email' => 80, 'message' => 5000];
foreach ($limits as $k => $max) {
    if ($form[$k] === '' || mb_strlen($form[$k]) > $max) {
        page(400, $config, 'Please fill in all fields (name up to 60, e-mail up to 80, message up to 5000 characters).');
    }
}
if (!filter_var($form['email'], FILTER_VALIDATE_EMAIL)) {
    page(400, $config, 'Please enter a valid e-mail address.');
}

$result = fc_verify($config, [
    'response' => posted(FC_FIELD),
    'hp' => posted(FC_HONEYPOT),
    'remoteip' => (string) ($_SERVER['REMOTE_ADDR'] ?? ''),   // behind a proxy: the real visitor address
    'email' => $form['email'],
    'name' => $form['name'],
    'content' => $form['message'],
]);

switch (fc_decide($result, fn () => independent_check_passed($form))) {
    case 'deliver':
        // Send the e-mail here. The example writes the message to data/delivered.jsonl.
        store($dataDir, 'delivered.jsonl', $form + ['score' => $result['score']]);
        page(200, $config, 'Thank you. Your message has been sent.');

    case 'hold':
        // HOLD FOR REVIEW: no clear pass (flag, or no clear answer from the service).
        // Keep the message for a human to look at - never deliver it silently.
        store($dataDir, 'held.jsonl', $form + [
            'why' => $result['unavailable'] ? 'unavailable' : $result['action'],
            'codes' => $result['codes'],
            'reasons' => $result['reasons'],
        ]);
        page(202, $config, 'Thank you. Your message has been received and will be reviewed before it is processed.');

    default:   // reject
        page(403, $config, in_array('service_unavailable', $result['reasons'], true)
            ? 'Your message could not be checked right now. Please try again in a few minutes.'
            : 'Your message could not be sent. Please reload the page and try again.');
}
