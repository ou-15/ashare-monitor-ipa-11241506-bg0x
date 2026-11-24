#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""行情看板 · Windows 桌面版

PySide6 + QtWebEngine 承载同一套四 Tab 页面，数据由内嵌的本地服务提供：
- 启动时在 127.0.0.1 上选一个空闲端口起 server.py 的 Handler（同源，无跨域）
- 窗口关掉时服务随之退出，不留后台进程
- 不需要填「服务地址」，页面直接走同源接口
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
# server.py 用 ASHARE_BASE 定位 web/ 与 config.json、cache/
os.environ["ASHARE_BASE"] = str(APP_DIR)
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

import server as srvmod  # noqa: E402


def start_service():
    last_err = None
    for port in range(8765, 8773):
        if not srvmod.port_usable(port):
            continue
        try:
            httpd = srvmod.FundHTTPServer(("127.0.0.1", port), srvmod.Handler)
        except OSError as exc:  # 端口刚被别人抢走
            last_err = exc
            continue
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        return httpd, port
    raise SystemExit("本地服务端口全部被占用：%s" % last_err)


def main() -> int:
    # 调试截图时关 GPU 合成，否则 ImageGrab 抓不到 WebEngine 画面（正式运行不设置）
    if "--shot" in sys.argv:
        os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu")

    httpd, port = start_service()

    from PySide6.QtCore import Qt, QUrl
    from PySide6.QtGui import QIcon
    from PySide6.QtWidgets import QApplication, QMainWindow
    from PySide6.QtWebEngineWidgets import QWebEngineView

    class MainWindow(QMainWindow):
        def __init__(self):
            super().__init__()
            self.setWindowTitle("行情看板")
            self.resize(430, 900)
            self.setMinimumSize(360, 620)
            self.setStyleSheet("QMainWindow{background:#0a0e20}")

            icon = APP_DIR / "web" / "icon-192.png"
            if icon.is_file():
                self.setWindowIcon(QIcon(str(icon)))

            self.view = QWebEngineView(self)
            self.view.setStyleSheet("background:#0a0e20")
            if "--debug" in sys.argv:
                from PySide6.QtWebEngineCore import QWebEnginePage

                class DebugPage(QWebEnginePage):
                    def javaScriptConsoleMessage(self, level, msg, line, src):
                        print("JS[%s] %s (%s:%s)" % (level, msg, src, line), flush=True)

                    def acceptNavigationRequest(self, url, nav_type, is_main_frame):
                        print("NAV type=%s main=%s url=%s"
                              % (nav_type, is_main_frame, url.toString()), flush=True)
                        return True

                self.view.setPage(DebugPage(self.view))
                self.view.loadFinished.connect(
                    lambda ok: print("LOAD_FINISHED ok=%s url=%s" % (ok, self.view.url().toString()),
                                     flush=True))

            self.view.setUrl(QUrl("http://127.0.0.1:%d/fund.html" % port))
            self.setCentralWidget(self.view)

        def keyPressEvent(self, event):
            if event.key() == Qt.Key_F11:
                if self.isFullScreen():
                    self.showNormal()
                else:
                    self.showFullScreen()
                return
            if event.key() == Qt.Key_Escape and self.isFullScreen():
                self.showNormal()
                return
            super().keyPressEvent(event)

    app = QApplication(sys.argv)
    app.setApplicationName("行情看板")
    app.setOrganizationName("AshareBoard")
    win = MainWindow()
    win.show()
    win.raise_()
    win.activateWindow()
    if "--shot" in sys.argv:
        # 调试截图时把窗口挪到屏幕右上角，避开鼠标指针，防止「显示瞬间被点链接」
        win.move(1460, 100)
    app.aboutToQuit.connect(httpd.shutdown)

    # 调试用：--shot <png> 启动 9 秒后截全屏再退出（打包后的正式使用不会走到这里）
    if "--shot" in sys.argv:
        from PySide6.QtCore import QTimer

        target = sys.argv[sys.argv.index("--shot") + 1]

        def snap():
            def after(extra=None):
                if extra is not None:
                    print("DOM:", extra, flush=True)
                try:
                    # 抓窗口自身，避免被别的窗口遮挡（软件渲染模式下 grab 能拿到 WebEngine 画面）
                    win.grab().save(target)
                    print("shot saved:", target, flush=True)
                finally:
                    app.quit()

            if "--debug" in sys.argv:
                win.view.page().runJavaScript(
                    "(function(){var w=document.querySelector('.wrap');"
                    "var c=document.querySelector('.card');"
                    "return 'wrap='+(w?('h'+w.offsetHeight+' w'+w.offsetWidth):'null')"
                    "+' card='+(c?('h'+c.offsetHeight+' vis'+getComputedStyle(c).display):'null')"
                    "+' txt='+(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,60);})()",
                    after)
            else:
                after()

        QTimer.singleShot(9000, snap)

    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
