package com.ashare.board;

import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.GZIPInputStream;

/**
 * 网页拿不到的行情/持仓接口（服务端校验 Referer），由原生代抓原始文本回传。
 * 页面侧：window.AshareNative.post('{"id":"..","url":"..","referer":".."}')
 * 回传：window.__fundFetchReply[id]({ok,status,body,error})
 */
public class Bridge {

    private static final Set<String> ALLOWED = new HashSet<>(Arrays.asList(
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
            // 美股指数与个股
            "quote.eastmoney.com",
            "np-listapi.eastmoney.com",
            // VIX 官方日线
            "cdn.cboe.com",
            // 资讯三源
            "news.10jqka.com.cn",
            "zhibo.sina.com.cn"
    ));

    private static final String UA =
            "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/124.0.0.0 Mobile Safari/537.36";

    private final WebView web;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);

    Bridge(WebView web) {
        this.web = web;
    }

    @JavascriptInterface
    public void post(final String json) {
        pool.execute(new Runnable() {
            @Override
            public void run() {
                handle(json);
            }
        });
    }

    private void handle(String json) {
        String id = "";
        boolean ok = false;
        int status = 0;
        String body = "";
        String error = "";

        try {
            JSONObject req = new JSONObject(json);
            id = req.optString("id", "");
            String raw = req.optString("url", "");
            String referer = req.optString("referer", "");

            URL url = new URL(raw);
            String host = url.getHost();
            if (host == null || !ALLOWED.contains(host.toLowerCase(Locale.ROOT))) {
                throw new IllegalArgumentException("host not allowed: " + host);
            }

            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(12000);
            conn.setReadTimeout(18000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", UA);
            conn.setRequestProperty("Accept-Encoding", "gzip, identity");
            if (referer != null && !referer.isEmpty()) {
                conn.setRequestProperty("Referer", referer);
            }

            status = conn.getResponseCode();
            InputStream is = (status >= 200 && status < 400) ? conn.getInputStream() : conn.getErrorStream();
            byte[] data = readAll(is);
            String enc = conn.getContentEncoding();
            if (enc != null && enc.toLowerCase(Locale.ROOT).contains("gzip")) {
                data = readAll(new GZIPInputStream(new java.io.ByteArrayInputStream(data)));
            }
            body = decode(data);
            ok = status == 200 && !body.isEmpty();
            if (!ok) error = "HTTP " + status;
            conn.disconnect();
        } catch (Exception e) {
            error = e.getClass().getSimpleName() + ": " + e.getMessage();
        }

        JSONObject payload = new JSONObject();
        try {
            payload.put("ok", ok);
            payload.put("status", status);
            payload.put("body", body);
            payload.put("error", error);
        } catch (Exception ignored) {
        }

        final String js = "window.__fundFetchReply&&window.__fundFetchReply["
                + JSONObject.quote(id) + "]&&window.__fundFetchReply[" + JSONObject.quote(id)
                + "](" + payload.toString() + ")";
        web.post(new Runnable() {
            @Override
            public void run() {
                web.evaluateJavascript(js, null);
            }
        });
    }

    private static byte[] readAll(InputStream is) throws Exception {
        if (is == null) return new byte[0];
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
        try {
            is.close();
        } catch (Exception ignored) {
        }
        return out.toByteArray();
    }

    /** 东财 / 腾讯部分接口是 GB18030，纯 UTF-8 解码会整段失败 */
    private static String decode(byte[] data) {
        if (data.length == 0) return "";
        try {
            String s = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(data)).toString();
            if (!s.isEmpty()) return s;
        } catch (CharacterCodingException ignored) {
        }
        try {
            String s = new String(data, Charset.forName("GB18030"));
            if (!s.isEmpty()) return s;
        } catch (Exception ignored) {
        }
        return new String(data, StandardCharsets.ISO_8859_1);
    }
}
