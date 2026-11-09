<?php
// 作者用：協力者の承認・止める、変更をまとめて戻す、サークル登録の確認、配置の置き場、公開（地図が読むファイルを書き出す）
require __DIR__ . '/_lib.php';
require_write();
$admin = require_admin();
$pdo = db();
$dataDir = site_dir() . '/data';

function published(string $dataDir): array {
  $out = [];
  foreach (['tags', 'circles', 'layout'] as $p) {
    $f = "$dataDir/$p.json";
    $out[$p] = is_file($f) ? filemtime($f) : null;
  }
  return $out;
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  $what = $_GET['what'] ?? '';
  if ($what === 'users') {
    $rows = $pdo->query('SELECT u.id, u.name, u.email, u.role, u.created_at, u.last_login,
      (SELECT COUNT(*) FROM tag_history h WHERE h.user_id = u.id AND h.reverted = 0) AS edits FROM users u ORDER BY u.role = "pending" DESC, u.last_login DESC LIMIT 500')->fetchAll();
    out(['users' => $rows]);
  }
  if ($what === 'circles') {
    $rows = $pdo->query('SELECT c.*, u.name AS user_name, u.email AS user_email FROM circles c JOIN users u ON u.id = c.user_id ORDER BY c.status = "pending" DESC, c.updated_at DESC LIMIT 1000')->fetchAll();
    foreach ($rows as &$r) {
      $r['codes'] = json_decode($r['codes'], true);
      $r['works'] = json_decode($r['works'], true);
      $r['chars'] = json_decode($r['chars'], true);
    }
    out(['circles' => $rows]);
  }
  if ($what === 'history') {
    $st = $pdo->prepare('SELECT h.*, u.name AS user_name FROM tag_history h JOIN users u ON u.id = h.user_id' . (isset($_GET['user']) ? ' WHERE h.user_id = ?' : '') . ' ORDER BY h.id DESC LIMIT 300');
    $st->execute(isset($_GET['user']) ? [(int)$_GET['user']] : []);
    out(['history' => $st->fetchAll()]);
  }
  if ($what === 'published') out(['published' => published($dataDir), 'hasLayout' => (bool)$pdo->query("SELECT 1 FROM kv WHERE k = 'layout'")->fetchColumn()]);
  fail('what');
}

$b = body();
$action = $b['action'] ?? '';
$now = time();

if ($action === 'role') {
  $role = $b['role'] ?? '';
  if (!in_array($role, ['user', 'pending', 'collab', 'banned'], true)) fail('role');
  $id = (int)($b['id'] ?? 0);
  if ($id === (int)$admin['id']) fail('自分は変えられません');
  $pdo->prepare('UPDATE users SET role = ? WHERE id = ? AND role <> "admin"')->execute([$role, $id]);
  if ($role === 'banned') {
    $pdo->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$id]);
    // 止めた人のサークル登録も止める（地図からすぐ外す。アカウントを作りなおしても止めたまま）
    circles_lock($pdo);
    $pdo->prepare("UPDATE circles SET status = 'rejected' WHERE user_id = ?")->execute([$id]);
    remember_circle_stop($pdo, $id);
    write_circles_json($pdo);
  }
  out(['ok' => true]);
}

if ($action === 'revert_user') {
  // その人の変更を新しい順に戻す。あとでほかの人が変えた所は、その人の変更が今の値のときだけ戻す
  $id = (int)($b['id'] ?? 0);
  $st = $pdo->prepare('SELECT * FROM tag_history WHERE user_id = ? AND reverted = 0 ORDER BY id DESC');
  $st->execute([$id]);
  $get = $pdo->prepare('SELECT data FROM tags WHERE day = ? AND code = ?');
  $put = $pdo->prepare('INSERT INTO tags (day, code, data, user_id, updated_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data), user_id = VALUES(user_id), updated_at = VALUES(updated_at)');
  $del = $pdo->prepare('DELETE FROM tags WHERE day = ? AND code = ?');
  $mark = $pdo->prepare('UPDATE tag_history SET reverted = 1 WHERE id = ?');
  $hist = $pdo->prepare('INSERT INTO tag_history (day, code, before_data, after_data, user_id, created_at, reverted) VALUES (?, ?, ?, ?, ?, ?, 1)');
  $n = 0; $skipped = 0;
  $pdo->beginTransaction();
  foreach ($st->fetchAll() as $h) {
    $get->execute([$h['day'], $h['code']]);
    $cur = $get->fetchColumn() ?: null;
    if ($cur !== $h['after_data']) { $skipped++; $mark->execute([$h['id']]); continue; }
    if ($h['before_data'] === null) $del->execute([$h['day'], $h['code']]);
    else $put->execute([$h['day'], $h['code'], $h['before_data'], $admin['id'], $now]);
    $hist->execute([$h['day'], $h['code'], $cur, $h['before_data'], $admin['id'], $now]);
    $mark->execute([$h['id']]);
    $n++;
  }
  $pdo->commit();
  out(['reverted' => $n, 'skipped' => $skipped]);
}

if ($action === 'circle') {
  // 出す（approved）か止める（rejected）か。確認なしで出すので、確認待ち（pending）はもう使わない
  $status = $b['status'] ?? '';
  if (!in_array($status, ['approved', 'rejected'], true)) fail('status');
  circles_lock($pdo);
  $id = (int)($b['id'] ?? 0);
  $pdo->prepare('UPDATE circles SET status = ?, note = ? WHERE id = ?')->execute([$status, mb_substr((string)($b['note'] ?? ''), 0, 300), $id]);
  $st = $pdo->prepare('SELECT user_id FROM circles WHERE id = ?');
  $st->execute([$id]);
  $uid = (int)$st->fetchColumn();
  if ($uid) {
    // 止めたら、その人を覚えておく（取り消してアカウントを作りなおしても止めたまま）。止めた登録がなくなれば忘れる
    if ($status === 'rejected') remember_circle_stop($pdo, $uid);
    else {
      $st = $pdo->prepare("SELECT COUNT(*) FROM circles WHERE user_id = ? AND status = 'rejected'");
      $st->execute([$uid]);
      if (!(int)$st->fetchColumn()) forget_circle_stop($pdo, $uid);
    }
  }
  // 止めたものはすぐ外し、戻したものはすぐ出す（サークルの登録は確認なしで出るので、公開中の一覧をいつも書きなおす）
  write_circles_json($pdo);
  out(['ok' => true]);
}

if ($action === 'delete_circle') {
  // サークル登録を消す（いたずらの登録など。消すと、同じ配置番号をほかの人が登録できる）
  circles_lock($pdo);
  $st = $pdo->prepare('SELECT image FROM circles WHERE id = ?');
  $st->execute([(int)($b['id'] ?? 0)]);
  if ($r = $st->fetch()) {
    remove_circle_image($r['image']);
    $pdo->prepare('DELETE FROM circles WHERE id = ?')->execute([(int)$b['id']]);
    write_circles_json($pdo);
  }
  out(['ok' => true]);
}

if ($action === 'layout') {
  $layout = $b['layout'] ?? null;
  if (!is_array($layout) || ($layout['format'] ?? '') !== 'comiket3d-layout' || !is_array($layout['lines'] ?? null)) fail('配置のファイルではありません');
  $pdo->prepare("INSERT INTO kv (k, v, updated_at) VALUES ('layout', ?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = VALUES(updated_at)")->execute([json_encode($layout, JSON_UNESCAPED_UNICODE), $now]);
  out(['ok' => true, 'lines' => count($layout['lines'])]);
}

if ($action === 'publish') {
  // 地図（公開版）が読むファイルを書き出す。false のものは消す（公開をやめる）
  $parts = $b['parts'] ?? [];
  if (!is_dir($dataDir)) mkdir($dataDir, 0755, true);
  $write = function (string $name, $data) use ($dataDir) {
    $tmp = "$dataDir/$name.json.tmp";
    file_put_contents($tmp, json_encode($data, JSON_UNESCAPED_UNICODE));
    rename($tmp, "$dataDir/$name.json");
  };
  if (array_key_exists('tags', $parts)) {
    if ($parts['tags']) {
      $days = ['1' => new stdClass(), '2' => new stdClass(), '3' => new stdClass()];
      foreach ($pdo->query('SELECT day, code, data FROM tags') as $r) $days[(string)$r['day']]->{$r['code']} = json_decode($r['data'], true);
      $write('tags', ['format' => 'comiket3d-tags', 'version' => 2, 'updated' => gmdate('c'), 'days' => $days]);
    } else @unlink("$dataDir/tags.json");
  }
  if (array_key_exists('circles', $parts)) {
    if ($parts['circles']) write_circles_json($pdo, true);
    else {
      @unlink("$dataDir/circles.json");
      foreach (glob("$dataDir/circles/*") ?: [] as $f) @unlink($f);
    }
  }
  if (array_key_exists('layout', $parts)) {
    if ($parts['layout']) {
      $v = $pdo->query("SELECT v FROM kv WHERE k = 'layout'")->fetchColumn();
      if (!$v) fail('配置がまだ置かれていません');
      $write('layout', json_decode($v, true)); // 書きかけを地図が読まないよう、別の名前で書いてから入れかえる
    } else @unlink("$dataDir/layout.json");
  }
  out(['published' => published($dataDir)]);
}
fail('action');
