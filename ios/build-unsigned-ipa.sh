#!/bin/bash
# 在 macOS 上生成「未签名 IPA」——签名由你自己完成。
# 单一 App：AshareBoard（底部四 Tab：基金 / 情绪 / 美股 / 资讯）
# 依赖：Xcode（含 iOS SDK）+ XcodeGen（brew install xcodegen）
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "未找到 Xcode。请从 App Store 安装 Xcode，打开一次并同意许可协议，然后重跑本脚本。"
  echo "若已安装仍报错，执行: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
  exit 1
fi

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "缺少 XcodeGen，请先执行: brew install xcodegen"
  echo "（没有 Homebrew 时：先装 https://brew.sh ，再执行上面这行）"
  exit 1
fi

if [ ! -f App/Resources/www/fund.html ]; then
  echo "提示：未见 www/fund.html，先执行  cp -r ../web App/Resources/www  （或让 CI/脚本同步）"
fi

echo "[1/3] 生成 Xcode 工程"
xcodegen generate

TARGETS=("AshareBoard")
IPS=()

echo "[2/3] 编译真机版本（ARM64，禁用签名）"
for TARGET in "${TARGETS[@]}"; do
  echo "  -> $TARGET"
  xcodebuild \
    -project AshareBoard.xcodeproj \
    -scheme "$TARGET" \
    -configuration Release \
    -sdk iphoneos \
    -destination 'generic/platform=iOS' \
    -derivedDataPath "build/$TARGET" \
    CODE_SIGNING_ALLOWED=NO \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGN_IDENTITY="" \
    clean build > "build-$TARGET.log" 2>&1 || {
      echo "编译失败，最后 20 行日志："
      tail -n 20 "build-$TARGET.log"
      exit 1
    }

  APP="$(find "build/$TARGET/Build/Products/Release-iphoneos" -maxdepth 1 -name '*.app' -type d | head -n 1)"
  if [ -z "$APP" ]; then
    echo "未找到 $TARGET 的 .app 产物"
    exit 1
  fi

  rm -rf Payload
  mkdir -p Payload
  cp -R "$APP" Payload/
  rm -f "$TARGET-unsigned.ipa"
  zip -qry "$TARGET-unsigned.ipa" Payload
  rm -rf Payload
  IPS+=("$TARGET-unsigned.ipa")
done

echo "[3/3] 完成"
echo ""
for f in "${IPS[@]}"; do
  echo "  $(pwd)/$f  ($(du -h "$f" | cut -f1))"
done
echo ""
echo "这是未签名 IPA，可用 Sideloadly / AltStore / Xcode 自行签名安装。"
echo "打开后默认进「基金」页，底部可切 情绪 / 美股 / 资讯。"
echo "数据：右上角「服务地址」填 http://<电脑IP>:8765 即全量可用；留空时基金页走本机直连。"
