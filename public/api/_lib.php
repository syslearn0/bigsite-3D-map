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
  // 開発用の localhost は、設定で allow_dev を true にしたときだけ
  $ok = ['https://sokubai3d.textetc.net'];
  if (!empty(cfg()['allow_dev'])) $ok[] = 'http://localhost:3200';
  if ($origin !== '' && !in_array($origin, $ok, true)) fail('bad origin', 403);
}

// 地図が読むサークルの一覧（data/circles.json）と、その画像を書き出す（作者が止めたものをのぞく。
// 確認なしで出すようにする前の「確認待ち」の登録も出す）。
// 公開をやめていた（circles.json がない）ときは、$force でなければ何もしない
function write_circles_json(PDO $pdo, bool $force = false): void {
  $dataDir = site_dir() . '/data';
  $imgDir = "$dataDir/circles";
  if (!$force && !is_file("$dataDir/circles.json")) return;
  if (!is_dir($imgDir)) mkdir($imgDir, 0755, true);
  $keep = [];
  $list = [];
  foreach ($pdo->query("SELECT * FROM circles WHERE status <> 'rejected' ORDER BY day, id") as $r) {
    $img = '';
    $thumb = '';
    $src = private_dir() . '/circles/' . basename($r['image']);
    if ($r['image'] !== '' && is_file($src)) {
      $img = basename($r['image']);
      if (!is_file("$imgDir/$img")) copy($src, "$imgDir/$img");
      $keep[] = $img;
      $ts = find_thumb(private_dir() . '/circles', $img);
      if ($ts !== '') {
        $thumb = basename($ts);
        if (!is_file("$imgDir/$thumb")) copy($ts, "$imgDir/$thumb");
        $keep[] = $thumb;
      }
    }
    $list[] = ['day' => (int)$r['day'], 'codes' => json_decode($r['codes'], true), 'name' => $r['name'], 'works' => json_decode($r['works'], true),
      'chars' => json_decode($r['chars'], true), 'x' => $r['x_account'], 'url' => $r['url'], 'image' => $img ? "/data/circles/$img" : '',
      'thumb' => $thumb ? "/data/circles/$thumb" : ''];
  }
  foreach (glob("$imgDir/*") ?: [] as $f) if (!in_array(basename($f), $keep, true)) @unlink($f);
  $tmp = "$dataDir/circles.json.tmp";
  file_put_contents($tmp, json_encode(['format' => 'comiket3d-circles', 'updated' => gmdate('c'), 'circles' => $list], JSON_UNESCAPED_UNICODE));
  rename($tmp, "$dataDir/circles.json");
}

// 小さい画像（机の札に出す）の名前：大きい画像の名前に _s をつけたもの（形は別のこともある）
function thumb_name(string $image, string $ext): string {
  return pathinfo(basename($image), PATHINFO_FILENAME) . '_s.' . $ext;
}
function find_thumb(string $dir, string $image): string {
  foreach (['webp', 'jpg', 'png'] as $e) if (is_file("$dir/" . thumb_name($image, $e))) return "$dir/" . thumb_name($image, $e);
  return '';
}

// 1 件のサークル登録の画像を消す（手元の分と、公開した分。小さい画像も）
function remove_circle_image(string $image): void {
  if ($image === '') return;
  foreach ([private_dir() . '/circles', site_dir() . '/data/circles'] as $dir) {
    @unlink("$dir/" . basename($image));
    foreach (['webp', 'jpg', 'png'] as $e) @unlink("$dir/" . thumb_name($image, $e));
  }
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
