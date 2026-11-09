<?php
// サークル本人の登録（1 人 1 日 1 件）。送るとすぐに地図に出る（ユーザーの指示：確認なし。作者が止めた登録は止めたまま）。
// サークルの登録の公開（管理の画面）をやめているあいだは、地図には出ない。
// GET：自分の登録の一覧。
// POST {days: [{day, codes[]}]（いくつかの日をまとめて。前の形の day・codes も読む）, name, works[], chars{}, x, url,
//   image?（data:image/webp;base64,… 400KB まで）, thumb?（机の札に出す小さい画像。40KB・400px まで）, removeImage?}
//   サークル名・作品・画像などは、送った日すべてに同じものを入れる
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
    remove_circle_image($r['image']);
    $pdo->prepare('DELETE FROM circles WHERE id = ?')->execute([$r['id']]);
    write_circles_json($pdo); // 公開中の一覧からも、すぐに消す
  }
  out(['circles' => mine($pdo, (int)$u['id'])]);
}

$b = body();
// 日ごとの配置番号（いくつかの日をまとめて送れる）
$daysIn = is_array($b['days'] ?? null) ? $b['days'] : [['day' => $b['day'] ?? 0, 'codes' => $b['codes'] ?? []]];
$days = [];
foreach ($daysIn as $d) {
  if (!is_array($d)) fail('日を選んでください');
  $day = (int)($d['day'] ?? 0);
  if (!in_array($day, [1, 2, 3], true)) fail('日を選んでください');
  if (isset($days[$day])) fail('同じ日が 2 回入っています');
  $codes = array_values(array_filter(clean_list($d['codes'] ?? [], 4, 20), 'valid_code'));
  if (!$codes) fail("{$day}日目の配置番号を入れてください");
  $days[$day] = $codes;
}
if (!$days) fail('日を選んでください');
ksort($days);
$name = trim(mb_substr((string)($b['name'] ?? ''), 0, 60));
if ($name === '') fail('サークル名を入れてください');
$works = clean_list($b['works'] ?? [], 10);
$chars = [];
// （作品名が数字だけのとき、PHP は配列のキーを数に変えるので、文字にして比べる）
if (is_array($b['chars'] ?? null)) foreach ($b['chars'] as $w => $list) if (in_array((string)$w, $works, true) && ($l = clean_list($list, 30))) $chars[(string)$w] = $l;
$x = preg_replace('/[^A-Za-z0-9_]/', '', ltrim((string)($b['x'] ?? ''), '@'));
$x = substr($x, 0, 30);
$url = trim((string)($b['url'] ?? ''));
if ($url !== '' && !preg_match('#^https://[^\s<>"]{3,280}$#', $url)) fail('URL は https:// から始めてください');

// 同じ日・同じ配置番号を、ほかの人がもう登録していれば断る（なりすまし防止）。どの日もそろって大丈夫なときだけ書く
$st = $pdo->prepare("SELECT codes FROM circles WHERE day = ? AND user_id <> ? AND status <> 'rejected'");
foreach ($days as $day => $codes) {
  $st->execute([$day, $u['id']]);
  foreach ($st as $r) foreach (json_decode($r['codes'], true) ?: [] as $c) if (in_array($c, $codes, true)) fail("{$day}日目の {$c} は、ほかの人が登録しています。間違いのときは作者に連絡してください", 409);
}

// 新しい画像（送った日すべてに、それぞれ別のファイルとして置く。日ごとの取り消しで、ほかの日の画像が消えないように）
$bin = null;
$ext = null;
$tb = null;
$text = null;
if (!empty($b['image'])) {
  if (!preg_match('#^data:image/(webp|jpeg|png);base64,([A-Za-z0-9+/=]+)$#', (string)$b['image'], $m)) fail('画像の形が読めません');
  $bin = base64_decode($m[2], true);
  if ($bin === false || strlen($bin) > 400000) fail('画像が大きすぎます');
  $info = @getimagesizefromstring($bin);
  if (!$info || $info[0] > 2000 || $info[1] > 2000) fail('画像が読めません');
  // 拡張子は、送られてきた名のりではなく、画像の中身の形から決める
  $ext = ['image/webp' => 'webp', 'image/jpeg' => 'jpg', 'image/png' => 'png'][$info['mime'] ?? ''] ?? null;
  if (!$ext) fail('webp・jpeg・png の画像にしてください');
  // 小さい画像（なくてもよい。そのときは地図が大きい画像を使う）
  if (!empty($b['thumb']) && preg_match('#^data:image/(webp|jpeg|png);base64,([A-Za-z0-9+/=]+)$#', (string)$b['thumb'], $m)) {
    $t = base64_decode($m[2], true);
    $ti = $t === false ? false : @getimagesizefromstring($t);
    $te = $ti ? (['image/webp' => 'webp', 'image/jpeg' => 'jpg', 'image/png' => 'png'][$ti['mime'] ?? ''] ?? null) : null;
    if ($te && strlen($t) <= 40000 && $ti[0] <= 400 && $ti[1] <= 400) [$tb, $text] = [$t, $te];
  }
}
$dir = private_dir() . '/circles';
if (!is_dir($dir)) mkdir($dir, 0700, true);
// 名前は乱数だけ（だれの画像か分からないように）
$newName = fn(string $e): string => bin2hex(random_bytes(12)) . '.' . $e;

$st = $pdo->prepare('SELECT id, day, image, status FROM circles WHERE user_id = ?');
$st->execute([$u['id']]);
$olds = [];
foreach ($st as $r) $olds[(int)$r['day']] = $r;
// 画像を選びなおさずに新しい日を足したときは、ほかの日の画像を写す
$copyFrom = '';
foreach ($olds as $r) if ($r['image'] !== '' && is_file("$dir/" . basename($r['image']))) { $copyFrom = basename($r['image']); break; }

foreach ($days as $day => $codes) {
  $old = $olds[$day] ?? null;
  $image = $old['image'] ?? '';
  if ($bin !== null) {
    remove_circle_image($image);
    $image = $newName($ext);
    file_put_contents("$dir/$image", $bin);
    if ($tb !== null) file_put_contents("$dir/" . thumb_name($image, $text), $tb);
  } elseif (!empty($b['removeImage'])) {
    remove_circle_image($image);
    $image = '';
  } elseif ($image === '' && $copyFrom !== '') {
    $image = $newName(pathinfo($copyFrom, PATHINFO_EXTENSION));
    copy("$dir/$copyFrom", "$dir/$image");
    $ts = find_thumb($dir, $copyFrom);
    if ($ts !== '') copy($ts, "$dir/" . thumb_name($image, pathinfo($ts, PATHINFO_EXTENSION)));
  }
  // 確認なしで地図に出す。作者が止めた（rejected）登録は、送りなおしても止めたまま
  $status = ($old['status'] ?? '') === 'rejected' ? 'rejected' : 'approved';
  $vals = [json_encode($codes, JSON_UNESCAPED_UNICODE), $name, json_encode($works, JSON_UNESCAPED_UNICODE), json_encode((object)$chars, JSON_UNESCAPED_UNICODE), $x, $url, $image, $now, $status];
  if ($old) {
    $pdo->prepare('UPDATE circles SET codes = ?, name = ?, works = ?, chars = ?, x_account = ?, url = ?, image = ?, updated_at = ?, status = ? WHERE id = ?')->execute([...$vals, $old['id']]);
  } else {
    $pdo->prepare('INSERT INTO circles (codes, name, works, chars, x_account, url, image, updated_at, status, user_id, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')->execute([...$vals, $u['id'], $day, $now]);
  }
}
write_circles_json($pdo); // 公開中なら、すぐ地図に出す
out(['circles' => mine($pdo, (int)$u['id'])]);
