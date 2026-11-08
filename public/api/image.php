<?php
// サークルの画像（公開前）を、本人と作者にだけ見せる。GET ?id=サークルの登録の番号
require __DIR__ . '/_lib.php';
$u = require_user();
$st = db()->prepare('SELECT user_id, image FROM circles WHERE id = ?');
$st->execute([(int)($_GET['id'] ?? 0)]);
$r = $st->fetch();
if (!$r || $r['image'] === '' || ((int)$r['user_id'] !== (int)$u['id'] && $u['role'] !== 'admin')) fail('not found', 404);
$f = private_dir() . '/circles/' . basename($r['image']);
if (!is_file($f)) fail('not found', 404);
$ext = pathinfo($f, PATHINFO_EXTENSION);
header('Content-Type: ' . ['webp' => 'image/webp', 'jpg' => 'image/jpeg', 'png' => 'image/png'][$ext]);
header('Cache-Control: private, max-age=60');
readfile($f);
