<?php
// 動作確認：PHP と DB につながるか（中身は出さない）
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
$out = ['php' => PHP_VERSION, 'pdo_mysql' => extension_loaded('pdo_mysql'), 'curl' => extension_loaded('curl'), 'openssl' => extension_loaded('openssl')];
$f = dirname(__DIR__, 3) . '/sokubai3d-config.php';
$out['config'] = is_file($f);
if ($out['config']) {
  try {
    $c = require $f;
    $pdo = new PDO("mysql:host={$c['db_host']};dbname={$c['db_name']};charset=utf8mb4", $c['db_user'], $c['db_pass'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $out['db'] = $pdo->query('SELECT VERSION()')->fetchColumn();
  } catch (Throwable $e) {
    $out['db'] = 'NG';
  }
}
echo json_encode($out);
