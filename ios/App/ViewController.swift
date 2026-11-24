import UIKit
import WebKit

/// 原生壳：内嵌 PWA 资源，用 WKWebView 全屏加载。
/// 启动页由 Info.plist 的 StartPage 决定：情绪监测=index.html，基金估值=fund.html。
/// 数据：首页可直连东方财富 JSONP；基金页需要电脑上的 Python 服务（填服务地址即可）。
final class ViewController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler {

    private var webView: WKWebView!
    private var fundBridge: FundBridge?
    private let apiKey = "ashare.apiBase"
    private let startPage = (Bundle.main.object(forInfoDictionaryKey: "StartPage") as? String) ?? "fund.html"

    // 网页里没有系统导航栏，全部 UI 由页面自绘（液态玻璃）；这里隐藏系统栏避免双头
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: false)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = (Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String) ?? "行情看板"
        view.backgroundColor = UIColor(red: 0.039, green: 0.055, blue: 0.125, alpha: 1.0)

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.userContentController.addUserScript(WKUserScript(
            source: apiBaseScript(), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // 持仓接口校验 Referer，网页侧拿不到，交给原生代抓（也让基金页脱离电脑独立运行）
        let bridge = FundBridge()
        config.userContentController.add(bridge, name: "fundFetch")
        // 页面内的「服务地址」入口：交给原生弹窗（系统栏已隐藏）
        config.userContentController.add(self, name: "appUI")
        fundBridge = bridge
        let wv = WKWebView(frame: .zero, configuration: config)
        bridge.webView = wv
        wv.navigationDelegate = self
        wv.allowsBackForwardNavigationGestures = true
        // 页面自己用 env(safe-area-inset-*) 处理刘海，WebView 不再叠加内边距
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.isOpaque = false
        wv.backgroundColor = .clear
        view.addSubview(wv)
        wv.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            wv.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            wv.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            wv.topAnchor.constraint(equalTo: view.topAnchor),
            wv.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        webView = wv

        loadApp()
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "appUI",
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        switch action {
        case "server":
            editServer()
        case "reload":
            webView.reload()
        default:
            break
        }
    }

    private func loadApp() {
        let page = (startPage as NSString).deletingPathExtension
        guard var url = Bundle.main.url(forResource: page,
                                        withExtension: "html",
                                        subdirectory: "www") else {
            showMissingAssets()
            return
        }
        let saved = UserDefaults.standard.string(forKey: apiKey) ?? ""
        if !saved.isEmpty, var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            comps.queryItems = [URLQueryItem(name: "api", value: saved)]
            if let qurl = comps.url { url = qurl }
        }
        let dir = url.deletingLastPathComponent()
        webView.loadFileURL(url, allowingReadAccessTo: dir)
    }

    /// 每个页面启动时把服务地址写进 localStorage，基金页读同一个键（apiBase）
    private func apiBaseScript() -> String {
        let saved = UserDefaults.standard.string(forKey: apiKey) ?? ""
        if saved.isEmpty {
            return "try{localStorage.removeItem('apiBase')}catch(e){}"
        }
        return "try{localStorage.setItem('apiBase', \(jsonLiteral(saved)))}catch(e){}"
    }

    private func jsonLiteral(_ s: String) -> String {
        guard let data = try? JSONEncoder().encode(s),
              let out = String(data: data, encoding: .utf8) else { return "\"\"" }
        return out
    }

    private func showMissingAssets() {
        let label = UILabel()
        label.text = "未找到内嵌网页资源 www/\(startPage)\n请先运行 cp -r web ios/App/Resources/www"
        label.numberOfLines = 0
        label.textAlignment = .center
        label.textColor = .secondaryLabel
        label.frame = view.bounds
        view.addSubview(label)
    }

    @objc private func reload() {
        webView.reload()
    }

    @objc private func editServer() {
        let alert = UIAlertController(
            title: "数据服务地址（可选）",
            message: "留空 = App 直接连东方财富公开接口实时取数，不依赖电脑。\n也可填电脑上 start.bat 启动的服务，例如 http://192.168.1.8:8765",
            preferredStyle: .alert)
        alert.addTextField { tf in
            tf.placeholder = "http://192.168.1.8:8765"
            tf.text = UserDefaults.standard.string(forKey: self.apiKey) ?? ""
            tf.keyboardType = .URL
            tf.autocapitalizationType = .none
            tf.autocorrectionType = .no
        }
        alert.addAction(UIAlertAction(title: "保存并重载", style: .default) { _ in
            let v = (alert.textFields?.first?.text ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            UserDefaults.standard.set(v, forKey: self.apiKey)
            // 立刻写进 localStorage（不用等下次启动注入），随后原地重载当前页
            let js = v.isEmpty
                ? "try{localStorage.removeItem('apiBase')}catch(e){}"
                : "try{localStorage.setItem('apiBase', \(self.jsonLiteral(v)))}catch(e){}"
            self.webView.evaluateJavaScript(js) { _, _ in
                self.webView.reload()
            }
        })
        alert.addAction(UIAlertAction(title: "接口自检", style: .default) { _ in
            self.openDiag()
        })
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        present(alert, animated: true)
    }

    /// 自检页：逐项跑真实请求，定位是哪一层没数据
    private func openDiag() {
        let dir = Bundle.main.bundleURL.appendingPathComponent("www")
        if let url = Bundle.main.url(forResource: "diag", withExtension: "html", subdirectory: "www") {
            webView.loadFileURL(url, allowingReadAccessTo: dir)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        print("WebView navigation failed: \(error.localizedDescription)")
    }

    /// 页面间跳转（基金 / 情绪 / 美股 / 资讯）时补上 ?api=，保证各页连的是同一个数据服务
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // 只处理主框架：子框架（预览 / 外部页面）原样放行，避免反复重载
        if let target = navigationAction.targetFrame, !target.isMainFrame {
            decisionHandler(.allow)
            return
        }
        let saved = UserDefaults.standard.string(forKey: apiKey) ?? ""
        guard !saved.isEmpty,
              let url = navigationAction.request.url,
              url.isFileURL,
              var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            decisionHandler(.allow)
            return
        }
        if comps.queryItems?.contains(where: { $0.name == "api" }) == true {
            decisionHandler(.allow)
            return
        }
        comps.queryItems = (comps.queryItems ?? []) + [URLQueryItem(name: "api", value: saved)]
        if let next = comps.url {
            decisionHandler(.cancel)
            if next.isFileURL {
                // WKWebView 不吃 file:// 的 URLRequest，必须走 loadFileURL
                webView.loadFileURL(next, allowingReadAccessTo: next.deletingLastPathComponent())
            } else {
                webView.load(URLRequest(url: next))
            }
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let name = (webView.url?.lastPathComponent ?? "").lowercased()
        if name.contains("us") {
            title = "美股"
        } else if name.contains("news") {
            title = "资讯"
        } else if name.contains("fund") {
            title = "基金估值"
        } else {
            title = "情绪监测"
        }
    }
}
