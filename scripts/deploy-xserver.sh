#!/usr/bin/env bash
# Xserver（https://sokubai3d.textetc.net/）へ公開版を置く。
# 使い方：bash scripts/deploy-xserver.sh
# ・rclone のリモート「xsv:」（Xserver のホームが起点。設定は手元の rclone のもの）で送る
# ・サーバーにある .user.ini と data/ は残し、ほかは手元の out/ とそろえる（古いファイルは消える）
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="xsv:textetc.net/public_html/sokubai3d.textetc.net"
rm -rf out
npm run build
# data/private（手元だけのデータ）が書き出しに入っていないか確かめる
if grep -rlq "layout-c109\|tags-c109" out; then echo "手元だけのデータが入っています。中止します" >&2; exit 1; fi
cp deploy/xserver.htaccess out/.htaccess
# data/（作者が「公開」で書き出したもの）はサーバーにしかないので消さない
rclone sync out "$DEST" --exclude ".user.ini" --exclude "data/**" --progress
echo "公開しました：https://sokubai3d.textetc.net/"
