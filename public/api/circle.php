<?php
// サークル本人の登録（1 人 1 日 1 件）。送るとすぐに地図に出る（ユーザーの指示：確認なし。作者が止めた登録は止めたまま）。
// サークルの登録の公開（管理の画面）をやめているあいだは、地図には出ない。
// GET：自分の登録の一覧。
// 同じ人は短い間に何度も送れない（rate_limit）。新しい登録・変更は作者にメールで知らせる。
// POST {days: [{day, codes[]}]（いくつかの日をまとめて。前の形の day・codes も読む）, drop?: [day]（取り消す日）, name, works[], chars{}, x, url,
//   image?（data:image/webp;base64,… 400KB まで）, thumb?（机の札に出す小さい画像。40KB・400px まで）, removeImage?}
//   サークル名・作品・画像などは、送った日すべてに同じものを入れる
// DELETE ?day=1：その日の登録を取り消す（?day=all：すべて）。作者が止めた登録は取り消せない（取り消して出しなおすのを防ぐ）
require __DIR__ . '/_lib.php';
require_write();
$u = require_user();
$pdo = db();
$now = time();
// 1 分に 3 回・1 時間に 15 回・1 日に 40 回まで（取り消しも数える）
const CIRCLE_LIMITS = [[60, 3], [3600, 15], [86400, 40]];
$published = fn(): bool => is_file(site_dir() . '/data/circles.json'); // 作者がサークルの登録を公開しているか

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

if ($_SERVER['REQUEST_METHOD'] === 'GET') out(['circles' => mine($pdo, (int)$u['id']), 'published' => $published()]);

// その人のその日の登録を消す（作者が止めた登録は消さずに断る）。消した登録の画像の名前を返す（$keepImages のときは、画像はまだ消さない）
function drop_days(PDO $pdo, int $uid, array $days, bool $keepImages = false): array {
  $st = $pdo->prepare('SELECT id, day, image, status FROM circles WHERE user_id = ?');
  $st->execute([$uid]);
  $rows = array_filter($st->fetchAll(), fn($r) => in_array((int)$r['day'], $days, true));
  foreach ($rows as $r) if ($r['status'] === 'rejected') fail("{$r['day']}日目の登録は作者が止めているので、取り消せません。作者に連絡してください", 403);
  $images = [];
  foreach ($rows as $r) {
    if ($keepImages) $images[] = $r['image'];
    else remove_circle_image($r['image']);
    $pdo->prepare('DELETE FROM circles WHERE id = ?')->execute([$r['id']]);
  }
  return $images;
}

circles_lock($pdo);
if ($_SERVER['REQUEST_METHOD'] === 'DELETE') {
  rate_limit($pdo, (int)$u['id'], 'circle', CIRCLE_LIMITS);
  $q = (string)($_GET['day'] ?? '');
  drop_days($pdo, (int)$u['id'], $q === 'all' ? [1, 2, 3] : [(int)$q]);
  write_circles_json($pdo); // 公開中の一覧からも、すぐに消す
  out(['circles' => mine($pdo, (int)$u['id']), 'published' => $published()]);
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
// いっしょに取り消す日（送った日は除く）
$drop = array_map('intval', is_array($b['drop'] ?? null) ? $b['drop'] : []);
$drop = array_values(array_unique(array_filter($drop, fn($d) => in_array($d, [1, 2, 3], true) && !isset($days[$d]))));
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

rate_limit($pdo, (int)$u['id'], 'circle', CIRCLE_LIMITS);

// 同じ日・同じ配置番号を、ほかの人がもう登録していれば断る（なりすまし防止）。どの日もそろって大丈夫なときだけ書く
// （circles_lock で、ほかの人の書きこみと重ならない）
$st = $pdo->prepare("SELECT c.codes FROM circles c JOIN users u ON u.id = c.user_id WHERE c.day = ? AND c.user_id <> ? AND c.status <> 'rejected' AND u.role <> 'banned'");
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

// 画像を選びなおさずに新しい日を足したときは、ほかの日の画像を写す（取り消す日の画像からも写せるよう、取り消す前に選ぶ）
$st = $pdo->prepare('SELECT image FROM circles WHERE user_id = ? ORDER BY day');
$st->execute([$u['id']]);
$copyFrom = '';
foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $img) if ($img !== '' && is_file("$dir/" . basename($img))) { $copyFrom = basename($img); break; }
// 取り消す日（止めた登録なら、ここで断る。まだ何も書いていない）。画像は、写し終わってから消す
$pdo->beginTransaction();
$droppedImages = drop_days($pdo, (int)$u['id'], $drop, true);
$st = $pdo->prepare('SELECT id, day, image, status FROM circles WHERE user_id = ?');
$st->execute([$u['id']]);
$olds = [];
foreach ($st as $r) $olds[(int)$r['day']] = $r;
// 作者がこの人の登録を止めたことがあれば（アカウントを作りなおしていても）、新しい日も止めたまま
$st = $pdo->prepare('SELECT 1 FROM circle_stops WHERE sub_hash = ?');
$st->execute([sub_hash((string)$u['sub'])]);
$stopped = (bool)$st->fetchColumn();

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
  $status = ($old['status'] ?? '') === 'rejected' || (!$old && $stopped) ? 'rejected' : 'approved';
  $vals = [json_encode($codes, JSON_UNESCAPED_UNICODE), $name, json_encode($works, JSON_UNESCAPED_UNICODE), json_encode((object)$chars, JSON_UNESCAPED_UNICODE), $x, $url, $image, $now, $status];
  if ($old) {
    $pdo->prepare('UPDATE circles SET codes = ?, name = ?, works = ?, chars = ?, x_account = ?, url = ?, image = ?, updated_at = ?, status = ? WHERE id = ?')->execute([...$vals, $old['id']]);
  } else {
    $pdo->prepare('INSERT INTO circles (codes, name, works, chars, x_account, url, image, updated_at, status, user_id, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')->execute([...$vals, $u['id'], $day, $now]);
  }
}
$pdo->commit();
foreach ($droppedImages as $img) remove_circle_image($img);
write_circles_json($pdo); // 公開中なら、すぐ地図に出す

// 作者に知らせる
$isNew = array_diff(array_keys($days), array_keys($olds));
$lines = [];
foreach ($days as $day => $codes) $lines[] = "  {$day}日目 " . implode('・', $codes) . (in_array($day, $isNew, true) ? '（新しい）' : '');
foreach ($drop as $day) $lines[] = "  {$day}日目 取り消し";
notify_admin(
  ($isNew ? '[即売会3Dマップ] 新しいサークル登録：' : '[即売会3Dマップ] サークル登録の変更：') . $name,
  "サークル名：{$name}\n" .
  "登録した人：{$u['name']}（{$u['email']}）\n" .
  implode("\n", $lines) . "\n" .
  ($works ? '作品：' . implode('・', $works) . "\n" : '') .
  ($x !== '' ? "X：@{$x}\n" : '') .
  ($url !== '' ? "URL：{$url}\n" : '') .
  ($bin !== null ? "画像：新しい画像あり\n" : '') .
  ($stopped ? "（この人は前に止めたことがあるので、止めたままにしました）\n" : '') .
  ($published() ? '地図にすぐ出ています。' : 'サークルの登録の公開が止まっているので、地図にはまだ出ていません。') . "\n" .
  "確認・止める：https://sokubai3d.textetc.net/admin/\n"
);
out(['circles' => mine($pdo, (int)$u['id']), 'published' => $published()]);
