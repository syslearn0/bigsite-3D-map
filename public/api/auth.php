<?php
// ログイン（Google の ID トークンを確かめて、この地図のログインにする）と、ログアウト
// POST {credential}：Google ログインのボタンが返した ID トークン
// DELETE：ログアウト
require __DIR__ . '/_lib.php';
require_write();

if ($_SERVER['REQUEST_METHOD'] === 'DELETE') {
  $tok = $_COOKIE[SESSION_COOKIE] ?? '';
  if (preg_match('/^[a-f0-9]{64}$/', $tok)) db()->prepare('DELETE FROM sessions WHERE token = ?')->execute([hash('sha256', $tok)]);
  setcookie(SESSION_COOKIE, '', ['expires' => time() - 3600, 'path' => '/', 'secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
  out(['ok' => true]);
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail('method', 405);

$cred = (string)(body()['credential'] ?? '');
if (strlen($cred) < 100 || strlen($cred) > 4096) fail('no credential');

// Google の確かめ口で、トークンの中身（署名・期限）を確かめる
$ch = curl_init('https://oauth2.googleapis.com/tokeninfo?id_token=' . urlencode($cred));
curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10]);
$res = curl_exec($ch);
$http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);
$info = json_decode((string)$res, true);
if ($res === false || $http >= 500) fail('Google に確かめられませんでした。しばらくしてからもう一度ログインしてください', 503);
if ($http !== 200 || !is_array($info)) fail('ログインを確かめられませんでした（もう一度ログインしてください）', 401);
if (($info['aud'] ?? '') !== GOOGLE_CLIENT_ID) fail('wrong audience', 401);
if (!in_array($info['iss'] ?? '', ['accounts.google.com', 'https://accounts.google.com'], true)) fail('wrong issuer', 401);
if ((int)($info['exp'] ?? 0) < time()) fail('expired', 401);
$sub = (string)($info['sub'] ?? '');
if ($sub === '') fail('no subject', 401);
$email = (($info['email_verified'] ?? '') === 'true' || ($info['email_verified'] ?? false) === true) ? (string)($info['email'] ?? '') : '';
$name = mb_substr((string)($info['name'] ?? ($info['given_name'] ?? '')), 0, 60);

$pdo = db();
$now = time();
$st = $pdo->prepare('SELECT * FROM users WHERE sub = ?');
$st->execute([$sub]);
$u = $st->fetch();
if ($u) {
  $pdo->prepare('UPDATE users SET email = ?, name = ?, last_login = ? WHERE id = ?')->execute([$email, $name, $now, $u['id']]);
} else {
  $role = is_admin_email($email) ? 'admin' : 'user';
  $pdo->prepare('INSERT INTO users (sub, email, name, role, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?)')->execute([$sub, $email, $name, $role, $now, $now]);
}
$st->execute([$sub]);
$u = $st->fetch();
if ($u['role'] === 'banned') fail('stopped', 403);

$tok = bin2hex(random_bytes(32));
$pdo->prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')->execute([hash('sha256', $tok), $u['id'], $now + SESSION_DAYS * 86400]);
$pdo->prepare('DELETE FROM sessions WHERE expires_at < ?')->execute([$now]);
setcookie(SESSION_COOKIE, $tok, ['expires' => $now + SESSION_DAYS * 86400, 'path' => '/', 'secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
if (is_admin_email($u['email'])) $u['role'] = 'admin';
out(['me' => me_json($u)]);
