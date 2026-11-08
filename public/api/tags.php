<?php
// 協力者が入れる、スペースごとの作品・キャラ（とジャンル）。
// GET ?day=1：その日の全部（協力者・作者だけ）。GET ?layout=1：協力者用の机の配置
// POST {day, changes: {code: {genre?, works?, chars?} | null}}：変えた分を送る（履歴に残す）
require __DIR__ . '/_lib.php';
require_write();
$u = require_collab();
$pdo = db();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  if (!empty($_GET['layout'])) {
    $v = $pdo->query("SELECT v FROM kv WHERE k = 'layout'")->fetchColumn();
    out(['layout' => $v ? json_decode($v, true) : null]);
  }
  $out = [];
  foreach ([1, 2, 3] as $d) $out[$d] = new stdClass();
  foreach ($pdo->query('SELECT day, code, data FROM tags') as $r) $out[(int)$r['day']]->{$r['code']} = json_decode($r['data'], true);
  out(['days' => $out]);
}

$b = body();
$day = (int)($b['day'] ?? 0);
if (!in_array($day, [1, 2, 3], true)) fail('day');
$changes = $b['changes'] ?? [];
if (!is_array($changes) || count($changes) > 3000) fail('too many');
$get = $pdo->prepare('SELECT data FROM tags WHERE day = ? AND code = ?');
$put = $pdo->prepare('INSERT INTO tags (day, code, data, user_id, updated_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data), user_id = VALUES(user_id), updated_at = VALUES(updated_at)');
$del = $pdo->prepare('DELETE FROM tags WHERE day = ? AND code = ?');
$hist = $pdo->prepare('INSERT INTO tag_history (day, code, before_data, after_data, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
$now = time();
$n = 0;
$pdo->beginTransaction();
foreach ($changes as $code => $t) {
  if (!is_string($code) || !valid_code($code)) continue;
  $get->execute([$day, $code]);
  $before = $get->fetchColumn() ?: null;
  $after = null;
  if (is_array($t)) {
    $tag = [];
    $g = trim(mb_substr((string)($t['genre'] ?? ''), 0, 60));
    if ($g !== '') $tag['genre'] = $g;
    $works = clean_list($t['works'] ?? [], 10);
    if ($works) $tag['works'] = $works;
    $chars = [];
    if (is_array($t['chars'] ?? null)) foreach ($t['chars'] as $w => $list) if (in_array($w, $works, true) && ($l = clean_list($list, 40))) $chars[$w] = $l;
    if ($chars) $tag['chars'] = $chars;
    if ($tag) $after = json_encode($tag, JSON_UNESCAPED_UNICODE);
  }
  if ($before === $after) continue;
  if ($after === null) $del->execute([$day, $code]);
  else $put->execute([$day, $code, $after, $u['id'], $now]);
  $hist->execute([$day, $code, $before, $after, $u['id'], $now]);
  $n++;
}
$pdo->commit();
out(['saved' => $n]);
