#!/usr/bin/env python3
"""Open a prototype or running app in the browser with the annotation overlay injected.

Usage:
  annotate.py <file.html>                      serve that file's folder
  annotate.py <http://host:port | host:port>   proxy an app that is already running
  annotate.py <url> --cmd "python server.py"   start the app first, stop it on exit

Everything goes through a small local proxy (127.0.0.1) that splices annotator.js into text/html
responses on the fly. The app is never modified. API calls, assets and navigation pass straight
through, so server-backed apps work. Ctrl+C stops it.

"Send to agent" in the overlay posts the feedback here: it is saved to --out (a temp folder by
default), printed, and the proxy exits, which wakes an agent that ran it in the background. The tab
waits and reloads when the proxy is relaunched on the same port.
Standard library only.
"""
import argparse
import functools
import http.client
import http.server
import json
import pathlib
import re
import shlex
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import webbrowser

HERE = pathlib.Path(__file__).resolve().parent
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers",
       "transfer-encoding", "upgrade", "content-length", "content-encoding"}


def find_annotator(override):
    candidates = [pathlib.Path(override)] if override else []
    candidates += [HERE.parent / "assets" / "annotator.js", HERE.parents[2] / "annotator.js"]
    for c in candidates:
        if c.is_file():
            return c
    sys.exit("annotator.js not found. Looked in: " + ", ".join(str(c) for c in candidates))


def make_handler(up, tag, boot, on_send):
    up_origin = f"{up.scheme}://{up.netloc}"

    class Proxy(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def reply(self, status, body, ctype="text/plain; charset=utf-8"):
            data = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def own_route(self):
            """The overlay's own endpoints. ping: which launch is serving (the waiting tab reloads when it
            changes). send: hand the feedback to the agent, then stop so the agent is woken up."""
            path = self.path.split("?")[0]
            if path == "/__annotate/ping":
                self.reply(200, json.dumps({"boot": boot}), "application/json")
            elif path == "/__annotate/send" and self.command == "POST":
                n = int(self.headers.get("Content-Length") or 0)
                try:
                    payload = json.loads(self.rfile.read(n) or b"{}")
                    saved = on_send(payload)
                except Exception as e:
                    self.reply(400, f"annotate: bad feedback ({e})")
                    return True
                self.reply(200, json.dumps({"saved": saved}), "application/json")
                threading.Timer(0.3, self.server.shutdown).start()
            else:
                self.reply(404, "annotate: unknown endpoint")
            return True

        def handle_any(self):
            if self.path.startswith("/__annotate/") and self.own_route():
                return
            conn_cls = http.client.HTTPSConnection if up.scheme == "https" else http.client.HTTPConnection
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n else None
            headers = {k: v for k, v in self.headers.items()
                       if k.lower() not in HOP and k.lower() not in ("host", "accept-encoding")}
            headers["Host"] = up.netloc
            headers["Accept-Encoding"] = "identity"  # keep the HTML injectable
            for h in ("Origin", "Referer"):  # keep the app's own origin checks happy
                if h in headers:
                    headers[h] = headers[h].replace(f"http://{self.headers.get('Host')}", up_origin)
            conn = conn_cls(up.hostname, up.port or (443 if up.scheme == "https" else 80), timeout=60)
            try:
                conn.request(self.command, self.path, body=body, headers=headers)
                r = conn.getresponse()
                data = r.read()
            except Exception as e:
                msg = f"annotate: cannot reach {up_origin} ({e})".encode()
                self.send_response(502)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
                return
            finally:
                conn.close()

            is_html = "text/html" in r.getheader("Content-Type", "").lower()
            if is_html and r.status not in (204, 304) and b"data-annotator-injected" not in data:
                m = list(re.finditer(rb"</body\s*>", data, re.I))
                t = tag.encode("utf-8")
                data = data[:m[-1].start()] + t + data[m[-1].start():] if m else data + b"\n" + t

            self.send_response(r.status, r.reason)
            for k, v in r.getheaders():
                kl = k.lower()
                if kl in HOP:
                    continue
                if kl == "location":
                    v = v.replace(up_origin, "")
                if is_html and kl in ("etag", "last-modified", "content-security-policy"):
                    continue  # body changed; CSP would block the inline script
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)

        do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = handle_any

    return Proxy


class QuietStatic(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def bind(handler, port):
    """Bind 127.0.0.1 on port, or the next free one (so a stale instance doesn't block a new run)."""
    for p in range(port, port + 10):
        try:
            return http.server.ThreadingHTTPServer(("127.0.0.1", p), handler)
        except OSError:
            continue
    sys.exit(f"Ports {port}-{port + 9} are all busy. Pass --port.")


def kill_with_me(proc):
    """Windows: put the app in a job object so it dies even if this script is killed outright."""
    if sys.platform != "win32":
        return
    import ctypes
    from ctypes import wintypes

    class Basic(ctypes.Structure):
        _fields_ = [("a", ctypes.c_int64), ("b", ctypes.c_int64), ("LimitFlags", wintypes.DWORD),
                    ("c", ctypes.c_size_t), ("d", ctypes.c_size_t), ("e", wintypes.DWORD),
                    ("f", ctypes.c_ssize_t), ("g", wintypes.DWORD), ("h", wintypes.DWORD)]

    class Extended(ctypes.Structure):
        _fields_ = [("Basic", Basic), ("io", ctypes.c_uint64 * 6), ("m", ctypes.c_size_t * 4)]

    k = ctypes.windll.kernel32
    k.CreateJobObjectW.restype = wintypes.HANDLE
    k.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    job = k.CreateJobObjectW(None, None)
    info = Extended()
    info.Basic.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    k.SetInformationJobObject(wintypes.HANDLE(job), 9, ctypes.byref(info), ctypes.sizeof(info))
    k.AssignProcessToJobObject(wintypes.HANDLE(job), wintypes.HANDLE(int(proc._handle)))
    return job  # keep a reference; the job closes when this process ends


def wait_for(host, port, proc, secs=30):
    end = time.time() + secs
    while time.time() < end:
        if proc and proc.poll() is not None:
            sys.exit(f"--cmd exited early with code {proc.returncode}.")
        try:
            socket.create_connection((host, port), timeout=1).close()
            return
        except OSError:
            time.sleep(0.3)
    sys.exit(f"Nothing listening on {host}:{port} after {secs}s.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target", help="an .html file, or the URL of a running app")
    ap.add_argument("--cmd", help="command that starts the app (URL mode); stopped on exit")
    ap.add_argument("--cwd", help="working directory for --cmd")
    ap.add_argument("--port", type=int, default=8766, help="annotated port (default 8766; keep it stable so reloads keep their comments)")
    ap.add_argument("--project", help="slug for saved comments (default: folder name, or host-port for a URL)")
    ap.add_argument("--keep-comments", action="store_true",
                    help="keep saved comments across relaunches (default: cleared on each launch)")
    ap.add_argument("--agent", action="store_true",
                    help="launched by a coding agent that waits on this process: show 'Send to agent' in the page")
    ap.add_argument("--out", help="folder for feedback sent from the page (default: <temp>/annotate-html)")
    ap.add_argument("--annotator", help="path to annotator.js")
    ap.add_argument("--no-open", action="store_true")
    a = ap.parse_args()

    as_file = pathlib.Path(a.target)
    if as_file.suffix.lower() in (".html", ".htm"):
        src = as_file.resolve()
        if not src.is_file():
            sys.exit(f"Not found: {src}")
        if ".annotated." in src.name.lower():
            sys.exit("That is an old annotated copy. Pass the original file.")
        if a.cmd:
            sys.exit("--cmd only applies to a URL target.")
        static = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0), functools.partial(QuietStatic, directory=str(src.parent)))
        threading.Thread(target=static.serve_forever, daemon=True).start()
        up = urllib.parse.urlparse(f"http://127.0.0.1:{static.server_address[1]}")
        start_path = "/" + urllib.parse.quote(src.name)
        default_slug = src.parent.name
        proc = None
    else:
        up = urllib.parse.urlparse(a.target if "://" in a.target else "http://" + a.target)
        if not up.hostname:
            sys.exit(f"Not a file or URL: {a.target}")
        start_path = up.path or "/"
        if up.query:
            start_path += "?" + up.query
        up = urllib.parse.urlparse(f"{up.scheme}://{up.netloc}")
        default_slug = f"{up.hostname}-{up.port or 80}"
        proc = subprocess.Popen(shlex.split(a.cmd, posix=False), cwd=a.cwd) if a.cmd else None
        job = kill_with_me(proc) if proc else None
        wait_for(up.hostname, up.port or (443 if up.scheme == "https" else 80), proc)

    project = re.sub(r"[^a-z0-9]+", "-", (a.project or default_slug).lower()).strip("-") or "prototype"
    js = find_annotator(a.annotator).read_text(encoding="utf-8").replace("</script", "<\\/script")
    boot = str(int(time.time() * 1000))
    run = "" if a.keep_comments else f' data-run="{boot}"'  # new run id = clear saved comments
    send = ' data-send="1"' if a.agent else ""  # the button only makes sense when an agent is waiting on this process
    tag = f'<script data-annotator-injected data-project="{project}" data-boot="{boot}"{send}{run}>\n{js}\n</script>\n'

    out_dir = pathlib.Path(a.out) if a.out else pathlib.Path(tempfile.gettempdir()) / "annotate-html"
    sent = {}

    def on_send(payload):
        text = str(payload.get("text") or "")
        if not text.strip():
            raise ValueError("no comments")
        out_dir.mkdir(parents=True, exist_ok=True)
        stem = out_dir / f"feedback-{project}-{time.strftime('%Y%m%d-%H%M%S')}"
        stem.with_suffix(".txt").write_text(text, encoding="utf-8")
        stem.with_suffix(".json").write_text(json.dumps(payload.get("json"), indent=2), encoding="utf-8")
        sent["path"] = str(stem.with_suffix(".txt"))
        return sent["path"]

    srv = bind(make_handler(up, tag, boot, on_send), a.port)
    port = srv.server_address[1]
    url = f"http://127.0.0.1:{port}{start_path}"
    print(f"Annotating {a.target} at {url}  (project: {project}; Ctrl+C to stop)", flush=True)
    if not a.no_open:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
        if proc and proc.poll() is None:
            proc.terminate()
    if sent:
        # The reviewer pressed "Send to agent". The tab is now waiting; relaunching on the same port
        # with --no-open makes it reload into the next round.
        print(f"\nFEEDBACK SENT: {sent['path']}  (JSON alongside)", flush=True)
        print(f"Re-review: relaunch with --port {port} --no-open\n", flush=True)
        print(pathlib.Path(sent["path"]).read_text(encoding="utf-8"), flush=True)


if __name__ == "__main__":
    main()
