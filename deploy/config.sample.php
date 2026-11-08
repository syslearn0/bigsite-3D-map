<?php
// sokubai3d の受け口（/api/*.php）が読む設定。公開フォルダ（public_html）の外に置く：
//   Xserver の ~/textetc.net/sokubai3d-config.php
// このひな形をコピーして、サーバーパネルの「MySQL設定」で作った値を入れる。パスワードは git に入れない。
return [
  'db_host' => 'localhost',          // サーバーパネルの「MySQL設定」に出ている MySQL ホスト名
  'db_name' => 'xs063970_sokubai3d', // 作ったデータベース名
  'db_user' => 'xs063970_sokubai',   // 作った MySQL ユーザー名
  'db_pass' => 'ここにパスワード',     // そのユーザーのパスワード
  'admin_emails' => ['作者の Google アカウントのメールアドレス'], // 作者（承認・公開ができる人）
];
