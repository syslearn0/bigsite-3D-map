<?php
// サークル本人の登録（1 人 1 日 1 件）。送るとすぐに地図に出る（ユーザーの指示：確認なし。作者が止めた登録は止めたまま）。
// サークルの登録の公開（管理の画面）をやめているあいだは、地図には出ない。
// GET：自分の登録の一覧。
// 同じ人は短い間に何度も送れない（rate_limit）。新しい登録・変更は作者にメールで知らせる。
// POST {days: [{day, codes[]}]（いくつかの日をまとめて。前の形の day・codes も読む）, drop?: [day]（取り消す日）, name, works[], chars{}, x, url,
//   images?: 3 つまで。それぞれ {data（data:image/webp;base64,… 400KB まで）, thumb?（机の札に出す小さい画像。40KB・400px まで）} か
//   {keep: n}（いま登録してある n 枚目、0 から）。並べた順に入れ、1 枚目が地図の机に出る。images がなければ画像は今のまま
//   （前の形の image?・thumb?・removeImage? も読む）}
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
      'chars' => json_decode($r['chars'], true), 'x' => $r['x_account'], 'url' => $r['url'], 'hasImage' => $r['image'] !== '', 'images' => count(img_list($r['image'])),
      'status' => $r['status'], 'note' => $r['note'], 'updatedAt' => (int)$r['updated_at']];
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

// 画像（3 枚まで）。送った日すべてに、それぞれ別のファイルとして置く（日ごとの取り消しで、ほかの日の画像が消えないように）
const MAX_IMAGES = 3;
$dir = private_dir() . '/circles';
if (!is_dir($dir)) mkdir($dir, 0700, true);
// 名前は乱数だけ（だれの画像か分からないように）
$newName = fn(string $e): string => bin2hex(random_bytes(12)) . '.' . $e;
// いま登録してある画像（どの日も同じなので、画像のある最初の日の分）。取り消す日の分からも使えるよう、取り消す前に読む
$st = $pdo->prepare('SELECT image FROM circles WHERE user_id = ? ORDER BY day');
$st->execute([$u['id']]);
$srcList = [];
// （ファイルがなくなっていても詰めない：画面の n 枚目・image.php の n と番号をそろえる）
foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $img) {
  if ($l = img_list($img)) {
    $srcList = $l;
    break;
  }
}
// 送られた画像の中身を読む（[中身, 形]。読めない・大きすぎるときは null）
$readImg = function (string $data, bool $small): ?array {
  if (!preg_match('#^data:image/(webp|jpeg|png);base64,([A-Za-z0-9+/=]+)$#', $data, $m)) return null;
  $bin = base64_decode($m[2], true);
  if ($bin === false || strlen($bin) > ($small ? 40000 : 400000)) return null;
  $info = @getimagesizefromstring($bin);
  $lim = $small ? 400 : 2000;
  if (!$info || $info[0] > $lim || $info[1] > $lim) return null;
  // 拡張子は、送られてきた名のりではなく、画像の中身の形から決める
  $ext = ['image/webp' => 'webp', 'image/jpeg' => 'jpg', 'image/png' => 'png'][$info['mime'] ?? ''] ?? null;
  return $ext ? [$bin, $ext] : null;
};
// いま登録してある画像を、ファイルから読む（[大きい画像, 形, 小さい画像|null, 形|null]）
$readOld = function (string $f) use ($dir): array {
  if (!is_file("$dir/$f")) fail('前の画像が見つかりません。画像を選びなおしてください');
  $ts = find_thumb($dir, $f);
  return [file_get_contents("$dir/$f"), pathinfo($f, PATHINFO_EXTENSION), $ts !== '' ? file_get_contents($ts) : null, $ts !== '' ? pathinfo($ts, PATHINFO_EXTENSION) : null];
};
// $imgs：新しく入れる画像の並び。null なら画像は今のまま
$imgs = null;
$items = null;
if (is_array($b['images'] ?? null)) $items = $b['images'];
elseif (!empty($b['image'])) $items = [['data' => $b['image'], 'thumb' => $b['thumb'] ?? '']];
elseif (!empty($b['removeImage'])) $items = [];
if ($items !== null) {
  if (count($items) > MAX_IMAGES) fail('画像は ' . MAX_IMAGES . ' 枚までです');
  $imgs = [];
  foreach ($items as $it) {
    if (!is_array($it)) fail('画像の形が読めません');
    if (array_key_exists('keep', $it)) {
      $f = $srcList[(int)$it['keep']] ?? null;
      if ($f === null) fail('前の画像が見つかりません。画像を選びなおしてください');
      $imgs[] = $readOld($f);
      continue;
    }
    $big = $readImg((string)($it['data'] ?? ''), false);
    if (!$big) fail('画像が読めないか、大きすぎます（webp・jpeg・png で 400KB まで）');
    // 小さい画像（なくてもよい。そのときは地図が大きい画像を使う）
    $small = !empty($it['thumb']) ? $readImg((string)$it['thumb'], true) : null;
    $imgs[] = [$big[0], $big[1], $small[0] ?? null, $small[1] ?? null];
  }
}
// 画像を置いて、ファイル名を「,」でつないで返す。書けなかったら（容量がいっぱいなど）、置いた分を消して断る
// （まだコミットの前なので、登録も前のまま。古い画像も消さない）
$putImgs = function (array $list) use ($dir, $newName): string {
  $names = [];
  foreach ($list as [$bin, $ext, $tb, $text]) {
    $n = $newName($ext);
    $ok = file_put_contents("$dir/$n", $bin) !== false;
    if ($ok && $tb !== null) $ok = file_put_contents("$dir/" . thumb_name($n, $text), $tb) !== false;
    $names[] = $n;
    if (!$ok) {
      remove_circle_image(implode(',', $names));
      fail('画像を保存できませんでした。時間をおいて、もう一度送ってください', 500);
    }
  }
  return implode(',', $names);
};
// 画像を選びなおさずに新しい日を足したときは、いま登録してある画像を写す（なくなったファイルは飛ばす。要るときだけ読む）
$copyImgs = null;
$copyList = function () use (&$copyImgs, $srcList, $dir, $readOld): array {
  return $copyImgs ??= array_map($readOld, array_values(array_filter($srcList, fn($f) => is_file("$dir/$f"))));
};
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
  if ($imgs !== null) {
    // 古い画像は、書き終わってから消す
    if ($image !== '') $droppedImages[] = $image;
    $image = $putImgs($imgs);
  } elseif ($image === '' && $srcList && $copyList()) {
    $image = $putImgs($copyList());
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
  ($imgs !== null ? '画像：' . count($imgs) . " 枚（選びなおした）\n" : '') .
  ($stopped ? "（この人は前に止めたことがあるので、止めたままにしました）\n" : '') .
  ($published() ? '地図にすぐ出ています。' : 'サークルの登録の公開が止まっているので、地図にはまだ出ていません。') . "\n" .
  "確認・止める：https://sokubai3d.textetc.net/admin/\n"
);
out(['circles' => mine($pdo, (int)$u['id']), 'published' => $published()]);
