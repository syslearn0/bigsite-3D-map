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

// 思わぬ失敗（DB のエラーなど）も、中身（パスや設定）を見せずに JSON で返す
set_exception_handler(function (Throwable $e): void {
  error_log('sokubai3d: ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
  if (!headers_sent()) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
  }
  echo json_encode(['error' => 'サーバーで失敗しました。少し待ってからやりなおしてください'], JSON_UNESCAPED_UNICODE);
});

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
  $v = 5;
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
  // 送った回数（同じ人が短い間に何度も送れないように）
  $pdo->exec("CREATE TABLE IF NOT EXISTS rate_log (
    user_id INT NOT NULL,
    action VARCHAR(20) NOT NULL,
    t INT NOT NULL,
    INDEX (user_id, action, t)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
  // 作者がサークルの登録を止めた人（Google のアカウントの番号のハッシュ）。アカウントを消して作りなおしても、止めたまま
  $pdo->exec("CREATE TABLE IF NOT EXISTS circle_stops (
    sub_hash CHAR(64) PRIMARY KEY,
    created_at INT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
  // 作品 10 × キャラ 30 が入るように（TEXT の 64KB をこえることがある）
  $pdo->exec("ALTER TABLE circles MODIFY chars MEDIUMTEXT NOT NULL");
  // 画像は 3 枚まで（ファイル名を「,」でつなぐ。1 枚目が地図の机に出る画像）
  $pdo->exec("ALTER TABLE circles MODIFY image VARCHAR(300) NOT NULL DEFAULT ''");
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

// サークルの登録を書きかえるあいだ、ほかの書きこみを待たせる（同じ配置番号の取り合い・同じ人の二重送信・一覧の書き出しが重ならないように）。
// 同じ接続の中では何度呼んでもよい。接続が終わると外れる
function circles_lock(PDO $pdo): void {
  if (!$pdo->query("SELECT GET_LOCK('s3d_circles', 15)")->fetchColumn()) fail('混みあっています。少し待ってからやりなおしてください', 503);
}

// 同じ人が短い間に何度も送れないようにする。$limits：[秒, 回数] のならび（その秒数のあいだに、その回数まで）
function rate_limit(PDO $pdo, int $uid, string $action, array $limits): void {
  $now = time();
  $longest = max(array_map(fn($l) => $l[0], $limits));
  $pdo->prepare('DELETE FROM rate_log WHERE t < ?')->execute([$now - 86400 * 2]);
  $st = $pdo->prepare('SELECT t FROM rate_log WHERE user_id = ? AND action = ? AND t > ? ORDER BY t DESC');
  $st->execute([$uid, $action, $now - $longest]);
  $ts = array_map('intval', $st->fetchAll(PDO::FETCH_COLUMN));
  foreach ($limits as [$sec, $max]) {
    $inside = array_values(array_filter($ts, fn($t) => $t > $now - $sec));
    if (count($inside) >= $max) {
      $wait = $inside[$max - 1] + $sec - $now; // いちばん古い分が外れるまで
      $when = $wait < 90 ? max(1, $wait) . ' 秒' : (int)ceil($wait / 60) . ' 分';
      fail("短いあいだに何度も送られています。{$when}ほど待ってから送ってください", 429);
    }
  }
  $pdo->prepare('INSERT INTO rate_log (user_id, action, t) VALUES (?, ?, ?)')->execute([$uid, $action, $now]);
}

// 作者に知らせる（メール）。送り先は設定の notify_emails（なければ admin_emails）。送れなくても登録は止めない
function notify_admin(string $subject, string $text): void {
  $to = cfg()['notify_emails'] ?? cfg()['admin_emails'] ?? [];
  if (!$to) return;
  mb_language('Japanese');
  mb_internal_encoding('UTF-8');
  $from = cfg()['mail_from'] ?? 'noreply@sokubai3d.textetc.net';
  foreach ($to as $addr) {
    if (!filter_var($addr, FILTER_VALIDATE_EMAIL)) continue;
    if (!@mb_send_mail($addr, $subject, $text, 'From: ' . mb_encode_mimeheader('即売会 3D マップ') . " <$from>")) error_log("sokubai3d: mail to admin failed");
  }
}

// Google のアカウントの番号（sub）のハッシュ（止めた人を覚えておくのに使う。番号そのものは残さない）
function sub_hash(string $sub): string { return hash('sha256', 'sokubai3d-stop:' . $sub); }
function user_sub(PDO $pdo, int $uid): string {
  $st = $pdo->prepare('SELECT sub FROM users WHERE id = ?');
  $st->execute([$uid]);
  $sub = (string)$st->fetchColumn();
  return strpos($sub, 'deleted-') === 0 ? '' : $sub;
}
function remember_circle_stop(PDO $pdo, int $uid): void {
  $sub = user_sub($pdo, $uid);
  if ($sub !== '') $pdo->prepare('INSERT IGNORE INTO circle_stops (sub_hash, created_at) VALUES (?, ?)')->execute([sub_hash($sub), time()]);
}
function forget_circle_stop(PDO $pdo, int $uid): void {
  $sub = user_sub($pdo, $uid);
  if ($sub !== '') $pdo->prepare('DELETE FROM circle_stops WHERE sub_hash = ?')->execute([sub_hash($sub)]);
}

// 地図が読むサークルの一覧（data/circles.json）と、その画像を書き出す（作者が止めたものをのぞく。
// 確認なしで出すようにする前の「確認待ち」の登録も出す）。
// 公開をやめていた（circles.json がない）ときは、$force でなければ何もしない
function write_circles_json(PDO $pdo, bool $force = false): void {
  $dataDir = site_dir() . '/data';
  $imgDir = "$dataDir/circles";
  if (!$force && !is_file("$dataDir/circles.json")) return;
  circles_lock($pdo);
  if (!is_dir($imgDir)) mkdir($imgDir, 0755, true);
  $keep = [];
  $list = [];
  // 止めた登録と、止めた人（banned）の登録は出さない
  foreach ($pdo->query("SELECT c.* FROM circles c JOIN users u ON u.id = c.user_id WHERE c.status <> 'rejected' AND u.role <> 'banned' ORDER BY c.day, c.id") as $r) {
    // 画像（3 枚まで）。1 枚目とその小さい画像が、地図の机に出る
    $imgs = [];
    $thumb = '';
    foreach (img_list($r['image']) as $img) {
      $src = private_dir() . '/circles/' . $img;
      if (!is_file($src)) continue;
      if (!is_file("$imgDir/$img")) copy($src, "$imgDir/$img");
      $keep[] = $img;
      $imgs[] = "/data/circles/$img";
      $ts = find_thumb(private_dir() . '/circles', $img);
      if ($ts !== '' && count($imgs) === 1) {
        $thumb = basename($ts);
        if (!is_file("$imgDir/$thumb")) copy($ts, "$imgDir/$thumb");
        $keep[] = $thumb;
      }
    }
    $list[] = ['day' => (int)$r['day'], 'codes' => json_decode($r['codes'], true), 'name' => $r['name'], 'works' => json_decode($r['works'], true),
      'chars' => json_decode($r['chars'], true), 'x' => $r['x_account'], 'url' => $r['url'], 'image' => $imgs[0] ?? '', 'images' => $imgs,
      'thumb' => $thumb ? "/data/circles/$thumb" : ''];
  }
  foreach (glob("$imgDir/*") ?: [] as $f) if (!in_array(basename($f), $keep, true)) @unlink($f);
  $tmp = "$dataDir/circles.json." . bin2hex(random_bytes(4)) . '.tmp';
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

// circles.image に入っている画像のファイル名（3 枚まで。「,」でつないである。前の 1 枚だけの形も同じに読める）
function img_list(string $s): array {
  return array_values(array_filter(array_map('basename', explode(',', $s)), fn($x) => $x !== '' && $x !== '.'));
}

// 1 件のサークル登録の画像を消す（手元の分と、公開した分。小さい画像も。3 枚とも）
function remove_circle_image(string $image): void {
  foreach (img_list($image) as $img)
    foreach ([private_dir() . '/circles', site_dir() . '/data/circles'] as $dir) {
      @unlink("$dir/$img");
      foreach (['webp', 'jpg', 'png'] as $e) @unlink("$dir/" . thumb_name($img, $e));
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
