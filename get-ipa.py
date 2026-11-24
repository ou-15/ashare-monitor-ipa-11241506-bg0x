#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
云端编译并取回未签名 IPA  —— Windows / macOS / Linux 通用，仅用 Python 标准库。

用法：
    python get-ipa.py <GitHub Token>
或：
    python get-ipa.py            # 交互式粘贴 Token
    python get-ipa.py --self-test  # 不联网写操作，自检文件清单与打包逻辑

流程：创建私有仓库 -> 上传工程 -> macOS Runner 编译 -> 下载产物 -> 写出 IPA。
Token 需要 classic PAT 的 repo + workflow 权限（或等价 fine-grained 权限）。
Token 不会写入任何文件、不会打印、不会上传。
"""
import base64
import io
import json
import os
import pathlib
import random
import string
import sys
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

API = "https://api.github.com"
ROOT = pathlib.Path(__file__).resolve().parent
OUT_IPA = ROOT / "AshareBoard-unsigned.ipa"
WORKFLOW = "build-unsigned-ipa.yml"
SKIP_SUFFIX = (".pyc", ".zip", ".ipa", "_direct.png", "_direct2.png", "_preview.png")


def log(msg):
    print(msg, flush=True)


def collect_files():
    files = []
    for p in sorted(ROOT.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(ROOT).as_posix()
        if "__pycache__" in rel or rel.startswith(".git/"):
            continue
        if any(rel.endswith(s) for s in SKIP_SUFFIX):
            continue
        if rel.endswith(".DS_Store"):
            continue
        # 本地缓存 / 日志 / 端口文件不上传
        if rel.startswith("cache/") or rel.endswith((".log", ".err", ".out")):
            continue
        if rel in ("runtime_port.txt", "auto-ipa.py", "make_icons.py"):
            continue
        # 截图/调试页不随包上传
        if pathlib.PurePosixPath(rel).name.startswith("_"):
            continue
        if "AshareBoard-unsigned.ipa" in rel:
            continue
        files.append((rel, p))
    return files


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(method, path, token=None, payload=None, raw=False, timeout=60, follow=True):
    url = path if path.startswith("http") else API + path
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "ashare-ipa-builder",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = "Bearer " + token
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    opener = urllib.request.build_opener()
    if not follow:
        opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(req, timeout=timeout) as resp:
            data = resp.read()
            if raw:
                return data, dict(resp.headers)
            return json.loads(data.decode("utf-8")) if data else {}
    except urllib.error.HTTPError as e:
        if not follow and e.code in (301, 302, 303, 307, 308):
            return b"", dict(e.headers)
        detail = e.read().decode("utf-8", "replace")[:600]
        raise RuntimeError("GitHub API %s %s -> HTTP %s: %s" % (method, path, e.code, detail)) from None
    except urllib.error.URLError as e:
        raise RuntimeError("网络请求失败: %s" % e.reason) from None


def get_token(argv):
    for a in argv[1:]:
        if not a.startswith("-"):
            return a.strip()
    tok = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if tok:
        return tok.strip()
    log("请粘贴 GitHub Token（输入内容不会显示、不会保存）：")
    try:
        import getpass
        return getpass.getpass("> ").strip()
    except Exception:
        return sys.stdin.readline().strip()


def self_test():
    files = collect_files()
    names = [n for n, _ in files]
    required = [
        "ios/project.yml", "ios/App/AppDelegate.swift", "ios/App/ViewController.swift",
        "ios/App/Info.plist", "ios/App/FundBridge.swift",
        "ios/build-unsigned-ipa.sh",
        "ios/App/Resources/www/index.html", "ios/App/Resources/www/fund.html",
        "ios/App/Resources/www/us.html", "ios/App/Resources/www/news.html",
        "ios/App/Resources/www/tabbar.css", "ios/App/Resources/www/tabbar.js",
        "ios/App/Resources/www/fund_direct.js",
        "web/app.js", "web/index.html", "web/fund.html", "web/fund.js",
        "web/us.html", "web/news.html", "web/tabbar.css", "web/tabbar.js",
        "web/fund_direct.js",
        ".github/workflows/" + WORKFLOW,
    ]
    missing = [r for r in required if r not in names]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for rel, p in files:
            z.write(p, rel)
    log("待上传文件数: %d" % len(files))
    log("打包体积: %d 字节" % len(buf.getvalue()))
    log("必需文件缺失: %s" % (", ".join(missing) if missing else "无"))
    log("IPA 输出路径: %s" % OUT_IPA)
    assert not missing, "工程文件不完整"
    assert zipfile.ZipFile(io.BytesIO(buf.getvalue())).testzip() is None
    log("SELF_TEST_OK")
    return 0


def upload_all(owner, repo, token, files):
    base = "/repos/%s/%s" % (owner, repo)

    def blob(item):
        rel, p = item
        content = p.read_bytes()
        res = request("POST", base + "/git/blobs", token,
                      {"content": base64.b64encode(content).decode("ascii"), "encoding": "base64"})
        return {"path": rel, "mode": "100644", "type": "blob", "sha": res["sha"]}

    entries = [None] * len(files)
    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(blob, item): i for i, item in enumerate(files)}
        done = 0
        for fut in as_completed(futs):
            entries[futs[fut]] = fut.result()
            done += 1
            if done % 8 == 0 or done == len(files):
                log("  上传文件 %d/%d" % (done, len(files)))
    tree = request("POST", base + "/git/trees", token, {"tree": entries})
    commit = request("POST", base + "/git/commits", token,
                     {"message": "iOS web shell + realtime data app", "tree": tree["sha"]})
    # 仓库已 auto_init 过，main 分支已存在：首次提交走 PATCH（force），否则 POST 新 ref
    try:
        request("POST", base + "/git/refs", token,
                {"ref": "refs/heads/main", "sha": commit["sha"]})
    except Exception as exc:  # noqa: BLE001
        if "409" not in str(exc) and "422" not in str(exc):
            raise
        request("PATCH", base + "/git/refs/heads/main", token,
                {"sha": commit["sha"], "force": True})
    return commit["sha"]


def find_or_dispatch_run(base, token):
    # 首次 push 通常会自动触发；若 25 秒内没有 run，则手动 dispatch。
    for _ in range(5):
        runs = request("GET", base + "/actions/runs?event=push&per_page=5", token).get("workflow_runs", [])
        if runs:
            log("检测到 push 自动触发的构建 #%s" % runs[0]["id"])
            return runs[0]["id"]
        time.sleep(5)
    log("未检测到自动构建，改用手动触发 …")
    request("POST", base + "/actions/workflows/%s/dispatches" % WORKFLOW, token, {"ref": "main"})
    for _ in range(12):
        time.sleep(5)
        runs = request("GET", base + "/actions/runs?event=workflow_dispatch&per_page=5", token).get("workflow_runs", [])
        if runs:
            log("检测到手动触发的构建 #%s" % runs[0]["id"])
            return runs[0]["id"]
    raise RuntimeError("已触发但未查到构建任务，请到仓库 Actions 页面查看")


def wait_run(base, token, run_id, limit_min=30):
    started = time.time()
    last = ""
    while time.time() - started < limit_min * 60:
        r = request("GET", base + "/actions/runs/%s" % run_id, token)
        status, conclusion = r.get("status"), r.get("conclusion")
        state = "%s/%s" % (status, conclusion)
        if state != last:
            log("  构建状态: %s  (已等待 %d 秒)" % (state, int(time.time() - started)))
            last = state
        if status == "completed":
            return conclusion, r.get("html_url", "")
        time.sleep(10)
    raise RuntimeError("构建超时（%d 分钟）" % limit_min)


def print_failure_logs(base, token, run_id):
    try:
        jobs = request("GET", base + "/actions/runs/%s/jobs" % run_id, token).get("jobs", [])
        for job in jobs:
            for step in job.get("steps", []):
                if step.get("conclusion") == "failure":
                    log("  失败步骤: %s" % step.get("name"))
        data, _ = request("GET", base + "/actions/runs/%s/logs" % run_id, token, raw=True, timeout=120)
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for name in z.namelist():
                if name.endswith(".txt"):
                    lines = z.read(name).decode("utf-8", "replace").strip().splitlines()
                    tail = [ln for ln in lines[-30:] if "error" in ln.lower() or "failed" in ln.lower() or "fatal" in ln.lower()]
                    for ln in (tail or lines[-12:]):
                        log("    " + ln[:200])
                    break
    except Exception as e:
        log("  （日志获取失败：%s）" % e)


def download_ipa(base, token, run_id):
    arts = request("GET", base + "/actions/runs/%s/artifacts" % run_id, token).get("artifacts", [])
    if not arts:
        raise RuntimeError("构建成功但没有上传产物")
    url = arts[0]["archive_download_url"]
    _, headers = request("GET", url, token, raw=True, follow=False)
    loc = headers.get("Location") or headers.get("location")
    if not loc:
        data, _ = request("GET", url, token, raw=True, timeout=180)
    else:
        req = urllib.request.Request(loc, headers={"User-Agent": "ashare-ipa-builder"})
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = resp.read()
    log("  产物包 %d 字节，正在解出 IPA …" % len(data))
    saved = []
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = [n for n in z.namelist() if n.lower().endswith(".ipa")]
        if not names:
            raise RuntimeError("产物包内没有 .ipa：%s" % z.namelist()[:10])
        for n in names:
            base_name = pathlib.Path(n).name
            # 单个产物沿用历史文件名，多个则各自原名（AshareMonitor / FundBoard）
            out = OUT_IPA if len(names) == 1 else ROOT / base_name
            out.write_bytes(z.read(n))
            saved.append(out)
            log("  已保存: %s (%d 字节)" % (out.name, out.stat().st_size))
    return saved


def main():
    argv = sys.argv
    if "--self-test" in argv:
        return self_test()
    token = get_token(argv)
    if not token:
        log("未提供 Token，已取消。")
        return 2
    log("[1/6] 校验 Token …")
    user = request("GET", "/user", token)
    login = user.get("login")
    if not login:
        raise RuntimeError("Token 无效或权限不足")
    log("  已登录账号: %s" % login)

    log("[2/6] 创建私有仓库 …")
    suffix = "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(4))
    name = "ashare-monitor-ipa-" + time.strftime("%m%d%H%M") + "-" + suffix
    repo = request("POST", "/user/repos", token, {
        "name": name, "private": True, "auto_init": True,
        "description": "A股实时情绪监测 iOS 壳工程（自动生成，用于出未签名 IPA）",
        "has_issues": False, "has_projects": False, "has_wiki": False,
    })
    owner, rname = repo["full_name"].split("/")
    base = "/repos/%s/%s" % (owner, rname)
    log("  仓库: %s (私有)" % repo["full_name"])

    log("[3/6] 上传工程文件 …")
    files = collect_files()
    upload_all(owner, rname, token, files)
    try:
        request("PATCH", base, token, {"default_branch": "main", "private": True})
    except Exception:
        pass

    log("[4/6] 等待 macOS 云主机构建（首次约 5-12 分钟）…")
    run_id = find_or_dispatch_run(base, token)
    conclusion, html_url = wait_run(base, token, run_id)
    if conclusion != "success":
        log("  构建失败: %s  详情: %s" % (conclusion, html_url))
        print_failure_logs(base, token, run_id)
        return 1

    log("[5/6] 下载编译产物 …")
    saved = download_ipa(base, token, run_id)

    log("[6/6] 完成！")
    log("")
    for f in saved:
        log("  IPA 文件: %s  (%.1f KB)" % (f.name, f.stat().st_size / 1024))
    log("  构建详情: %s" % html_url)
    log("")
    log("这是未签名 IPA，可用 Sideloadly / AltStore / Xcode 按你的方式签名安装。")
    log("AshareBoard 是四 Tab 看板（基金/情绪/美股/资讯），首次打开可在右上角填服务地址 http://<电脑IP>:8765")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log("\n已取消。")
        sys.exit(130)
    except Exception as exc:
        log("\n失败: %s" % exc)
        sys.exit(1)
