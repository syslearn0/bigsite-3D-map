<?php
// 利用者の印・メモ・「行った」を端末のあいだで合わせる。
// 1 つ 1 つの項目（k：「m|1|東A-01a」など）に、最後に変えた時刻（t、ミリ秒）と値（v、消したときは null）を持つ。
// POST {entries: {k: {v, t}}}：端末で変えた分を送る。サーバーの方が新しいものは上書きしない。
// 返すのは、その人の全部の項目（数百件ほどなので全部返す）
require __DIR__ . '/_lib.php';
require_write();
$u = require_user();
$pdo = db();
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
  $entries = body()['entries'] ?? [];
  if (!is_array($entries) || count($entries) > 5000) fail('too many');
  $up = $pdo->prepare('INSERT INTO user_entries (user_id, k, v, t) VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE v = IF(VALUES(t) > t, VALUES(v), v), t = GREATEST(t, VALUES(t))');
  $pdo->beginTransaction();
  $now = (int)(microtime(true) * 1000) + 60000;
  foreach ($entries as $k => $e) {
    if (!is_string($k) || !preg_match('/^[mnv]\|[123]\|[^|]{3,40}$/u', $k) || !is_array($e)) continue;
    $t = (int)($e['t'] ?? 0);
    if ($t <= 0) continue;
    $t = min($t, $now); // 端末の時計が進んでいても捨てない（サーバーの時刻にそろえる）
    $v = $e['v'] ?? null;
    if ($v !== null) $v = mb_substr((string)$v, 0, 400);
    $up->execute([$u['id'], $k, $v, $t]);
  }
  $pdo->commit();
}
$st = $pdo->prepare('SELECT k, v, t FROM user_entries WHERE user_id = ?');
$st->execute([$u['id']]);
$all = [];
foreach ($st as $r) $all[$r['k']] = ['v' => $r['v'], 't' => (int)$r['t']];
out(['entries' => (object)$all]);
