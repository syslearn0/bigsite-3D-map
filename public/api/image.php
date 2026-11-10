<?php
// サークルの画像（公開前）を、本人と作者にだけ見せる。GET ?id=サークルの登録の番号&n=何枚目（0 から。なければ 1 枚目）
require __DIR__ . '/_lib.php';
$u = require_user();
$st = db()->prepare('SELECT user_id, image FROM circles WHERE id = ?');
$st->execute([(int)($_GET['id'] ?? 0)]);
$r = $st->fetch();
if (!$r || $r['image'] === '' || ((int)$r['user_id'] !== (int)$u['id'] && $u['role'] !== 'admin')) fail('not found', 404);
$name = img_list($r['image'])[(int)($_GET['n'] ?? 0)] ?? '';
if ($name === '') fail('not found', 404);
$f = private_dir() . '/circles/' . $name;
if (!is_file($f)) fail('not found', 404);
$type = ['webp' => 'image/webp', 'jpg' => 'image/jpeg', 'png' => 'image/png'][pathinfo($f, PATHINFO_EXTENSION)] ?? null;
if (!$type) fail('not found', 404);
header('Content-Type: ' . $type);
header('Cache-Control: private, max-age=60');
readfile($f);
