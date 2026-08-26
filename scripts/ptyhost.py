#!/usr/bin/env python3
"""Minimal PTY host, so scripts/fake-ttyd.js can run a real interactive program
without a native Node addon.

    ptyhost.py <cols> <rows> <command> [args...]

  stdin  -> the pty (keystrokes)
  pty    -> stdout (terminal output)
  fd 3   -> control channel: "<cols> <rows>\\n" resizes the pty

Exits with the child's exit status.
"""

import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_winsize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    if len(sys.argv) < 4:
        sys.stderr.write("usage: ptyhost.py <cols> <rows> <command> [args...]\n")
        return 2
    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    argv = sys.argv[3:]

    pid, fd = pty.fork()
    if pid == 0:
        os.environ.setdefault("TERM", "xterm-256color")
        try:
            os.execvp(argv[0], argv)
        except OSError as exc:
            sys.stderr.write(f"ptyhost: cannot exec {argv[0]}: {exc}\n")
            os._exit(127)

    set_winsize(fd, cols, rows)

    try:
        ctrl = os.fdopen(3, "rb", buffering=0)
    except OSError:
        ctrl = None

    out = sys.stdout.buffer
    sources = [fd, 0] + ([ctrl.fileno()] if ctrl else [])
    ctrl_buf = b""

    while True:
        try:
            readable, _, _ = select.select(sources, [], [])
        except InterruptedError:
            continue

        if fd in readable:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if not data:
                break
            out.write(data)
            out.flush()

        if 0 in readable:
            data = os.read(0, 65536)
            if not data:
                sources.remove(0)
            else:
                os.write(fd, data)

        if ctrl and ctrl.fileno() in readable:
            chunk = os.read(ctrl.fileno(), 4096)
            if not chunk:
                sources.remove(ctrl.fileno())
                ctrl = None
            else:
                ctrl_buf += chunk
                while b"\n" in ctrl_buf:
                    line, ctrl_buf = ctrl_buf.split(b"\n", 1)
                    parts = line.split()
                    if len(parts) == 2:
                        try:
                            set_winsize(fd, int(parts[0]), int(parts[1]))
                            os.kill(pid, signal.SIGWINCH)
                        except (ValueError, OSError):
                            pass

    os.close(fd)
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    sys.exit(main())
