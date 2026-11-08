<?php
// sokubai3d の受け口の共通部分：設定・DB・表の用意・ログインの確認・JSON の返し方
// 設定（DB のパスワードなど）は公開フォルダの外の ~/textetc.net/sokubai3d-config.php（git に入れない）

declare(strict_types=1);

const GOOGLE_CLIENT_ID = '1087195504372-ubukmlq5fct3oif6he1av9lfdacsrqs5.apps.googleusercontent.com';
const SESSION_COOKIE = 's3d_sess';
const SESSION_DAYS = 60;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function cfg(): array {
  static $c = null;
  if ($c === null) $c = require dirname(__DIR__, 3) . '/sokubai3d-config.php';
  return $c;
}

// サイトのフォルダ（public_html/sokubai3d.textetc.net）と、公開しない置き場（画像の受け取りなど）
function site_dir(): string { return dirname(__DIR__); }
function private_dir(): string {
  $d = dirname(__DIR__, 3) . '/sokubai3d-private';
  if (!is_dir($d)) mkdir($d, 0700, true);
  return $d;
}

function db(): PDO {
  static $pdo = null;
  if ($pdo) return $pdo;
  $c = cfg();
  $pdo = new PDO("mysql:host={$c['db_host']};dbname={$c['db_name']};charset=utf8mb4", $c['db_user'], $c['db_pass'], [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    PDO::ATTR_EMULATE_PREPARES => false,
  ]);
  migrate($pdo);
  return $pdo;
}

// 表がなければ作る（はじめての呼び出しのとき）
function migrate(PDO $pdo): void {
  $v = 3;
  $f = private_dir() . '/schema-version';
  if (is_file($f) && (int)file_get_contents($f) >= $v) return;
  $pdo->exec("CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sub VARCHAR(64) NOT NULL UNIQUE,
    email VARCHAR(190) NOT NULL DEFAULT '',
    name VARCHAR(190) NOT NULL DEFAULT '',
    role VARCHAR(16) NOT NULL DEFAULT 'user',
    created_at INT NOT NULL,
    last_login INT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
  $pdo->exec("CREATE TABLE IF NOT EXISTS sessions (
    token CHAR(64) PRIMARY KEY,
    user_id INT NOT NULL,
    expires_at INT NOT NULL,
    INDEX (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
  $pdo->exec("CREATE TABLE IF NOT EXISTS user_entries (
    user_id INT NOT NULL,
    k VARCHAR(120) NOT NULL,
    v TEXT NULL,
    t BIGINT NOT NULL,
    PRIMARY KEY (user_id, k)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
  $pdo->exec("CREATE TABLE IF NOT EXISTS tags (
    day TINYINT NOT NULL,
    code VARCHAR(40) NOT NULL,
    data TEXT NOT NULL,
    user_id INT NOT NULL,
    updated_at INT NOT NULL,
    PRIMARY KEY (day, code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
  $pdo->exec("CREATE TABLE IF NOT EXISTS tag_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    day TINYINT NOT NULL,
    code VARCHAR(40) NOT NULL,
    before_data TEXT NULL,
    after_data TEXT NULL,
    user_id INT NOT NULL,
    created_at INT NOT NULL,
    reverted TINYINT NOT NULL DEFAULT 0,
    INDEX (user_id), INDEX (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
  $pdo->exec("CREATE TABLE IF NOT EXISTS circles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    day TINYINT NOT NULL,
    codes VARCHAR(200) NOT NULL,
    name VARCHAR(120) NOT NULL,
    works TEXT NOT NULL,
    chars TEXT NOT NULL,
    x_account VARCHAR(60) NOT NULL DEFAULT '',
    url VARCHAR(300) NOT NULL DEFAULT '',
    image VARCHAR(120) NOT NULL DEFAULT '',
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    note VARCHAR(300) NOT NULL DEFAULT '',
    created_at INT NOT NULL,
    updated_at INT NOT NULL,
    UNIQUE KEY one_per_day (user_id, day)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
  $pdo->exec("CREATE TABLE IF NOT EXISTS kv (
    k VARCHAR(64) PRIMARY KEY,
    v MEDIUMTEXT NOT NULL,
    updated_at INT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
  file_put_contents($f, (string)$v);
}

function out($data, int $code = 200): void {
  http_response_code($code);
  echo json_encode($data, JSON_UNESCAPED_UNICODE);
  exit;
}
function fail(string $msg, int $code = 400): void { out(['error' => $msg], $code); }

function body(): array {
  $raw = file_get_contents('php://input');
  $j = json_decode($raw ?: 'null', true);
  return is_array($j) ? $j : [];
}

// 書きこむ呼び出しは、同じサイトの画面からだけ（ほかのサイトのフォームからの送信を断る）
function require_write(): void {
  if ($_SERVER['REQUEST_METHOD'] === 'GET') return;
  if (($_SERVER['HTTP_X_S3D'] ?? '') !== '1') fail('bad request', 403);
  $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
  if ($origin !== '' && !in_array($origin, ['https://sokubai3d.textetc.net', 'http://localhost:3200'], true)) fail('bad origin', 403);
}

function is_admin_email(string $email): bool {
  return in_array(strtolower($email), array_map('strtolower', cfg()['admin_emails'] ?? []), true);
}

// いまログインしている人（いなければ null）
function current_user(): ?array {
  static $u = false;
  if ($u !== false) return $u;
  $u = null;
  $tok = $_COOKIE[SESSION_COOKIE] ?? '';
  if (!preg_match('/^[a-f0-9]{64}$/', $tok)) return null;
  $st = db()->prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?');
  $st->execute([hash('sha256', $tok), time()]);
  $row = $st->fetch();
  if ($row) {
    if (is_admin_email($row['email']) && $row['role'] !== 'admin') {
      db()->prepare("UPDATE users SET role = 'admin' WHERE id = ?")->execute([$row['id']]);
      $row['role'] = 'admin';
    }
    $u = $row;
  }
  return $u;
}

function require_user(): array {
  $u = current_user();
  if (!$u) fail('login required', 401);
  if ($u['role'] === 'banned') fail('stopped', 403);
  return $u;
}
function require_collab(): array {
  $u = require_user();
  if (!in_array($u['role'], ['collab', 'admin'], true)) fail('collaborators only', 403);
  return $u;
}
function require_admin(): array {
  $u = require_user();
  if ($u['role'] !== 'admin') fail('admin only', 403);
  return $u;
}

function me_json(?array $u): ?array {
  if (!$u) return null;
  return ['id' => (int)$u['id'], 'name' => $u['name'], 'email' => $u['email'], 'role' => $u['role']];
}

// 配置番号の形（「東A-01a」「西あ-12b」など）
function valid_code(string $c): bool {
  return (bool)preg_match('/^[東西南]\S{1,4}-\d{2}[ab]$/u', $c);
}
function clean_list($a, int $max = 30, int $len = 60): array {
  if (!is_array($a)) return [];
  $out = [];
  foreach ($a as $s) {
    if (!is_string($s)) continue;
    $s = trim(mb_substr($s, 0, $len));
    if ($s !== '' && !in_array($s, $out, true)) $out[] = $s;
    if (count($out) >= $max) break;
  }
  return $out;
}
