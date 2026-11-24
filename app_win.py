#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""行情看板 · Windows 桌面版（WebView2 内核）

用 pywebview 承载同一套四 Tab 页面，渲染内核是本机 Edge/WebView2：
- 安装体积比 PySide6 小一个数量级，冷启动 1~2 秒
- 数据仍由内嵌的本地服务提供（127.0.0.1 同源，不依赖电脑上另开的 Python）
- localStorage 持久化到 cache/webview，自选基金重启不丢
"""
from __future__ import annotations

import os
import sys
import threading
from pathlib import Path


def app_dir() -> Path:
    """资源根：优先 exe 同级的 web/（用户可自换页面），否则用 PyInstaller 解包目录。"""
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        if (exe_dir / "web" / "fund.html").is_file():
            return exe_dir
        return Path(getattr(sys, "_MEIPASS", exe_dir))
    return Path(__file__).resolve().parent


APP_DIR = app_dir()
os.environ["ASHARE_BASE"] = str(APP_DIR)
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

import server as srvmod  # noqa: E402


def log(msg):
    """窗口版没有控制台，把关键信息落到 cache/app.log，便于排查。"""
    try:
        import time
        d = APP_DIR / "cache"
        d.mkdir(parents=True, exist_ok=True)
        with open(d / "app.log", "a", encoding="utf-8") as f:
            f.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


def start_service():
    """桌面版直接让系统分配空闲端口。

    固定 8765 会和网页服务 / 另一个实例抢同一个端口（Windows 上还能假绑定成功），
    端口一冲突页面就会连到别的进程、数据时有时无。随机端口只给本窗口用，永不冲突。
    """
    try:
        httpd = srvmod.FundHTTPServer(("127.0.0.1", 0), srvmod.Handler)
    except OSError as exc:
        raise SystemExit("本地服务启动失败：%s" % exc)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    log("service on 127.0.0.1:%d (system assigned)" % port)
    try:
        (APP_DIR / "cache" / "port.txt").write_text(str(port), encoding="utf-8")
    except Exception:
        pass
    return httpd, port



def main() -> int:
    # 关键路径：端口选择 → 建窗 → 进入消息循环。窗口版没有控制台，异常一律落日志。
    import traceback
    try:
        return _run()
    except SystemExit as exc:
        log("fatal(SystemExit): %s" % exc)
        traceback.print_exc()
        raise
    except Exception:
        log("fatal:\n" + traceback.format_exc())
        raise


def _run() -> int:
    log("start, base=%s" % APP_DIR)
    httpd, port = start_service()
    url = "http://127.0.0.1:%d/fund.html" % port

    import webview

    storage = APP_DIR / "cache" / "webview"
    storage.mkdir(parents=True, exist_ok=True)

    webview.create_window(
        "行情看板",
        url,
        width=430,
        height=900,
        min_size=(360, 620),
        background_color="#0a0e20",
        text_select=True,
        zoomable=False,
        confirm_close=False,
    )
    try:
        webview.start(gui="edgechromium", debug=False, private_mode=False,
                      storage_path=str(storage))
    finally:
        try:
            httpd.shutdown()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
