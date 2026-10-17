#!/usr/bin/env python3
"""从唯一主目录启动当前构建；开发数据固定保存，测试装配不进入日常入口。"""
from pathlib import Path
import argparse
import fcntl
import json
import os
import shutil
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description="启动当前 D Code 开发版")
    parser.add_argument("--check", action="store_true", help="只检查入口，不启动窗口")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    package = json.loads((root / "package.json").read_text())
    electron = root / "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    state = Path.home() / "Library/Application Support/D Code Development"
    npm = shutil.which("npm")
    if sys.platform != "darwin":
        raise RuntimeError("当前桌面启动入口仅支持 macOS")
    if npm is None or not electron.is_file():
        raise RuntimeError("缺少 npm 或已锁定的 Electron 运行文件，请按 README 安装工程依赖")
    if args.check:
        print(json.dumps({"version": package["version"], "source": str(root),
                          "entry_exists": (root / "out/main/index.js").is_file(),
                          "brand_exists": (root / "resources/brand/dcode-owl-master.png").is_file(),
                          "state_directory": str(state)}, ensure_ascii=False))
        return
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Electron 的 GPU／网络辅助进程会在 ready 回调前读取 userData；先准备同一隔离 profile 目录。
    (state / "userdata").mkdir(parents=True, exist_ok=True, mode=0o700)
    # 防止同一固定入口同时构建/启动两个实例；锁只覆盖启动过程，不删除用户数据。
    with (state / "launch.lock").open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("D Code 正在启动，请稍候。")
            return
        record = state / "desktop-process.json"
        if record.exists():
            try:
                prior = json.loads(record.read_text())
                pid = prior["pid"]
                if not isinstance(pid, int) or pid <= 0:
                    raise ValueError("invalid pid")
                check = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "command="],
                                       capture_output=True, text=True, check=False)
                if (prior.get("source") == str(root) and check.returncode == 0
                        and str(electron) in check.stdout and str(root) in check.stdout):
                    print("D Code 已在运行，请从 Dock 打开。要载入刚更新的代码，请先退出该窗口再启动。")
                    return
            except (OSError, ValueError, KeyError, TypeError):
                # 进程记录不是工作数据；无效或过期记录不证明实例仍存活，也不授权结束其他进程。
                pass
        env = {key: value for key, value in os.environ.items()
               if not key.startswith("DCODE_") and key not in
               ("ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL")}
        print("正在构建 D Code " + package["version"] + "…", flush=True)
        subprocess.run([npm, "run", "build"], cwd=root, env=env, check=True, timeout=120)
        env["DCODE_STATE_DIR"] = str(state)
        with (state / "runtime.log").open("ab") as log:
            proc = subprocess.Popen([str(electron), f"--user-data-dir={state / 'userdata'}", str(root)], cwd=root, env=env,
                                    stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                    start_new_session=True)
        record.write_text(json.dumps({"pid": proc.pid, "source": str(root),
                                      "version": package["version"]}, ensure_ascii=False))
        print("正在打开 D Code " + package["version"] + "。")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print("启动未完成：" + str(error), file=sys.stderr)
        sys.exit(1)
