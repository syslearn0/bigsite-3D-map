<?php
// サークル本人の登録（1 人 1 日 1 件）。作者が確かめて「公開」すると地図に出る。
// GET：自分の登録の一覧。POST {day, codes[], name, works[], chars{}, x, url, image?（data:image/webp;base64,… 300KB まで）}
// DELETE ?day=1：その日の登録を取り消す
require __DIR__ . '/_lib.php';
require_write();
$u = require_user();
$pdo = db();
$now = time();

function mine(PDO $pdo, int $uid): array {
  $st = $pdo->prepare('SELECT id, day, codes, name, works, chars, x_account, url, image, status, note, updated_at FROM circles WHERE user_id = ? ORDER BY day');
  $st->execute([$uid]);
  $out = [];
  foreach ($st as $r) {
    $out[] = ['id' => (int)$r['id'], 'day' => (int)$r['day'], 'codes' => json_decode($r['codes'], true), 'name' => $r['name'], 'works' => json_decode($r['works'], true),
      'chars' => json_decode($r['chars'], true), 'x' => $r['x_account'], 'url' => $r['url'], 'hasImage' => $r['image'] !== '', 'status' => $r['status'], 'note' => $r['note'], 'updatedAt' => (int)$r['updated_at']];
  }
  return $out;
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') out(['circles' => mine($pdo, (int)$u['id'])]);

if ($_SERVER['REQUEST_METHOD'] === 'DELETE') {
  $day = (int)($_GET['day'] ?? 0);
  $st = $pdo->prepare('SELECT id, image FROM circles WHERE user_id = ? AND day = ?');
  $st->execute([$u['id'], $day]);
  if ($r = $st->fetch()) {
    if ($r['image'] !== '') @unlink(private_dir() . '/circles/' . $r['image']);
    $pdo->prepare('DELETE FROM circles WHERE id = ?')->execute([$r['id']]);
  }
  out(['circles' => mine($pdo, (int)$u['id'])]);
}

$b = body();
$day = (int)($b['day'] ?? 0);
if (!in_array($day, [1, 2, 3], true)) fail('日を選んでください');
$codes = array_values(array_filter(clean_list($b['codes'] ?? [], 4, 20), 'valid_code'));
if (!$codes) fail('配置番号を選んでください');
$name = trim(mb_substr((string)($b['name'] ?? ''), 0, 60));
if ($name === '') fail('サークル名を入れてください');
$works = clean_list($b['works'] ?? [], 10);
$chars = [];
if (is_array($b['chars'] ?? null)) foreach ($b['chars'] as $w => $list) if (in_array($w, $works, true) && ($l = clean_list($list, 30))) $chars[$w] = $l;
$x = preg_replace('/[^A-Za-z0-9_]/', '', ltrim((string)($b['x'] ?? ''), '@'));
$x = substr($x, 0, 30);
$url = trim((string)($b['url'] ?? ''));
if ($url !== '' && !preg_match('#^https://[^\s<>"]{3,280}$#', $url)) fail('URL は https:// から始めてください');

// 同じ日・同じ配置番号を、ほかの人がもう登録していれば断る（なりすまし防止。作者が確かめる）
$st = $pdo->prepare('SELECT codes FROM circles WHERE day = ? AND user_id <> ?');
$st->execute([$day, $u['id']]);
foreach ($st as $r) foreach (json_decode($r['codes'], true) ?: [] as $c) if (in_array($c, $codes, true)) fail("{$c} は、ほかの人が登録しています。間違いのときは作者に連絡してください", 409);

$st = $pdo->prepare('SELECT id, image FROM circles WHERE user_id = ? AND day = ?');
$st->execute([$u['id'], $day]);
$old = $st->fetch();
$image = $old['image'] ?? '';
if (!empty($b['image'])) {
  if (!preg_match('#^data:image/(webp|jpeg|png);base64,([A-Za-z0-9+/=]+)$#', (string)$b['image'], $m)) fail('画像の形が読めません');
  $bin = base64_decode($m[2], true);
  if ($bin === false || strlen($bin) > 400000) fail('画像が大きすぎます');
  $info = @getimagesizefromstring($bin);
  if (!$info || $info[0] > 2000 || $info[1] > 2000) fail('画像が読めません');
  $dir = private_dir() . '/circles';
  if (!is_dir($dir)) mkdir($dir, 0700, true);
  if ($image !== '') @unlink($dir . '/' . $image);
  $image = $u['id'] . '-' . $day . '-' . bin2hex(random_bytes(6)) . '.' . ($m[1] === 'jpeg' ? 'jpg' : $m[1]);
  file_put_contents($dir . '/' . $image, $bin);
} elseif (!empty($b['removeImage']) && $image !== '') {
  @unlink(private_dir() . '/circles/' . $image);
  $image = '';
}
$vals = [json_encode($codes, JSON_UNESCAPED_UNICODE), $name, json_encode($works, JSON_UNESCAPED_UNICODE), json_encode((object)$chars, JSON_UNESCAPED_UNICODE), $x, $url, $image, $now];
if ($old) {
  // 変えたら、もう一度作者が確かめる
  $pdo->prepare("UPDATE circles SET codes = ?, name = ?, works = ?, chars = ?, x_account = ?, url = ?, image = ?, updated_at = ?, status = 'pending' WHERE id = ?")->execute([...$vals, $old['id']]);
} else {
  $pdo->prepare("INSERT INTO circles (codes, name, works, chars, x_account, url, image, updated_at, user_id, day, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')")->execute([...$vals, $u['id'], $day, $now]);
}
out(['circles' => mine($pdo, (int)$u['id'])]);
