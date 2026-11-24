============================================================
  帮个忙：3 分钟生成一个 iOS 安装包（未签名 IPA）
  只需一台 Mac，不需要苹果开发者账号、不需要证书、不需要签名
============================================================

【第 1 步】解压这个压缩包，打开「终端」（Terminal）。

【第 2 步】打开「终端」（Terminal），做两下：

  2a. 输入  cd  （cd 后面留一个空格），然后把解压出来的
      ios 文件夹直接拖进终端窗口（路径会自动填好），按回车。

  2b. 粘贴这一行，回车：

      bash build-unsigned-ipa.sh

  （若提示缺少 xcodegen，先执行下面两行，再重跑 2b）
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      brew install xcodegen

【第 3 步】等 1~3 分钟，屏幕出现：

    完成: .../ios/AshareMonitor-unsigned.ipa

    把这个 AshareMonitor-unsigned.ipa 文件发回给我就行
    （微信 / QQ 直接传文件即可，几十 KB）。

------------------------------------------------------------
常见问题
------------------------------------------------------------
Q: 提示「未找到 Xcode」
A: App Store 免费装 Xcode，装完打开一次、点同意许可协议。

Q: 提示 xcode-select 相关错误
A: 执行 sudo xcode-select -s /Applications/Xcode.app/Contents/Developer

Q: 提示签名 / Signing 相关错误
A: 脚本已经关闭签名，正常不会报。若报错把终端截图发我。

Q: 这个工程安全吗
A: 只有三个 Swift 文件 + 一份网页（HTML/JS/CSS/图标），
   没有第三方依赖、不会下载或执行任何外部代码。
   原生层只对基金持仓这一个域名代发请求（白名单限制）。
   编译产物是未签名 IPA，签名由需求方自己完成。

------------------------------------------------------------
技术说明（可忽略）
------------------------------------------------------------
XcodeGen 读取 project.yml 生成 .xcodeproj，
xcodebuild 以 CODE_SIGNING_ALLOWED=NO 编译 arm64 真机版，
再把 .app 装进 Payload/ 压缩成 IPA。
Bundle ID: com.ashare.monitor，部署目标 iOS 15.0。

------------------------------------------------------------
【附】一次会出两个 App
  AshareMonitor-unsigned.ipa   A股情绪监测（进首页，可直连接口）
  FundBoard-unsigned.ipa       基金估值看板（直接进基金页）
  两个 App 共用同一套网页资源，只是启动页与名称不同。

  基金页默认不需要电脑：服务地址留空时走「本机直连」，
  净值、名称、实时行情由 App 自己联网获取；前十大持仓这家
  接口校验 Referer，网页里拿不到，由 App 原生层（FundBridge.swift）
  带着 Referer 代抓回来再解析。收盘对账样本也存在手机本地。
  想用电脑上的服务（更省手机流量、缓存更久）就在右上角
  「服务地址」填 http://电脑IP:8765，两者可随时切换。
------------------------------------------------------------
