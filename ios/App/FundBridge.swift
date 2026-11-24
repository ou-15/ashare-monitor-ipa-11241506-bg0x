import Foundation
import WebKit
import CoreFoundation

/// 网页拿不到的行情/持仓接口（服务端校验 Referer），由 App 原生代抓原始文本回传。
/// 网页侧：window.webkit.messageHandlers.fundFetch.postMessage({id,url,referer})
/// 回传：window.__fundFetchReply[id]({ok,status,body,error})
final class FundBridge: NSObject, WKScriptMessageHandler {

    weak var webView: WKWebView?

    /// 只允许抓这几个数据源，避免被页面拿去做任意代理
    private let allowedHosts: Set<String> = [
        // 基金 / 持仓 / A 股行情
        "fundf10.eastmoney.com",
        "fund.eastmoney.com",
        "qt.gtimg.cn",
        "push2.eastmoney.com",
        "push2delay.eastmoney.com",
        "82.push2.eastmoney.com",
        "push2ex.eastmoney.com",
        // 新浪全市场行情（东财 clist 被限流时，情绪页改由原生拉全量分页）
        "vip.stock.finance.sina.com.cn",
        // 美股指数与个股（东财 ulist.np / clist）
        "quote.eastmoney.com",
        "np-listapi.eastmoney.com",
        // VIX 官方日线
        "cdn.cboe.com",
        // 资讯三源
        "news.10jqka.com.cn",
        "zhibo.sina.com.cn"
    ]

    private let ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
        + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "fundFetch",
              let body = message.body as? [String: Any],
              let id = body["id"] as? String,
              let raw = body["url"] as? String,
              let url = URL(string: raw),
              let host = url.host,
              allowedHosts.contains(host) else {
            return
        }

        var req = URLRequest(url: url)
        req.timeoutInterval = 20
        req.setValue(ua, forHTTPHeaderField: "User-Agent")
        if let referer = body["referer"] as? String, !referer.isEmpty {
            req.setValue(referer, forHTTPHeaderField: "Referer")
        }

        URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
            guard let self = self else { return }
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            var text = ""
            if let data = data {
                text = self.decode(data)
            }
            let failure = err?.localizedDescription ?? (text.isEmpty ? "返回内容为空" : "")
            let ok = err == nil && status == 200 && !text.isEmpty
            let js = "window.__fundFetchReply&&window.__fundFetchReply[\(self.json(id))]"
                + "({ok:\(ok),status:\(status),body:\(self.json(text)),error:\(self.json(failure))})"
            DispatchQueue.main.async {
                self.webView?.evaluateJavaScript(js, completionHandler: nil)
            }
        }.resume()
    }

    /// 东财 / 腾讯的部分接口是 GB18030，纯 UTF-8 解码会整段失败（就是「原生桥有响应但页面没数据」的根源）
    private func decode(_ data: Data) -> String {
        if let s = String(data: data, encoding: .utf8), !s.isEmpty { return s }
        // 0x0632 = kCFStringEncodingGB_18030_2000（用数值避免不同 SDK 的枚举名差异）
        let gb = CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(0x0632))
        if let s = String(data: data, encoding: String.Encoding(rawValue: gb)), !s.isEmpty { return s }
        return String(data: data, encoding: .isoLatin1) ?? ""
    }

    private func json(_ s: String) -> String {
        guard let data = try? JSONEncoder().encode(s),
              let out = String(data: data, encoding: .utf8) else { return "\"\"" }
        return out
    }
}
