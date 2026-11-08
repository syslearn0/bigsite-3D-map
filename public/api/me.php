<?php
// いまログインしている人と、自分のサークル登録の状態。POST {apply: true} で協力者を申し込む
require __DIR__ . '/_lib.php';
require_write();
$u = current_user();
if ($_SERVER['REQUEST_METHOD'] === 'DELETE') {
  // アカウントを消す：印・メモ・サークルの登録（画像も）・ログインを消す。協力者として入れた作品・キャラの履歴は、名前を消して残す
  $u = require_user();
  if ($u['role'] === 'admin') fail('作者のアカウントは消せません');
  $pdo = db();
  $id = (int)$u['id'];
  $st = $pdo->prepare('SELECT image FROM circles WHERE user_id = ?');
  $st->execute([$id]);
  foreach ($st->fetchAll() as $r) remove_circle_image($r['image']);
  $pdo->prepare('DELETE FROM circles WHERE user_id = ?')->execute([$id]);
  write_circles_json($pdo); // 公開中の一覧からも消す
  $pdo->prepare('DELETE FROM user_entries WHERE user_id = ?')->execute([$id]);
  $pdo->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$id]);
  $pdo->prepare("UPDATE users SET sub = ?, email = '', name = '（消したアカウント）', role = 'user' WHERE id = ?")->execute(['deleted-' . $id, $id]);
  setcookie(SESSION_COOKIE, '', ['expires' => time() - 3600, 'path' => '/', 'secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
  out(['ok' => true]);
}
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
  $u = require_user();
  if (!empty(body()['apply']) && $u['role'] === 'user') {
    db()->prepare("UPDATE users SET role = 'pending' WHERE id = ?")->execute([$u['id']]);
    $u['role'] = 'pending';
  }
}
out(['me' => me_json($u), 'clientId' => GOOGLE_CLIENT_ID]);
