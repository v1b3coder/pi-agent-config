#!/usr/bin/env python3
"""Unyka thermal printer (USB 1fc9:2016) — CLI + library.

Hardware-verified ESC/POS wrapper for this specific printer:
  - 80 mm paper, 576-dot printhead (48 chars Font A / 64 chars Font B)
  - Czech via ESC t 18 (CP852)
  - firmware self-reports are unreliable; only paper-verified facts here

CLI:
  sg lp -c 'python unyka_printer.py status'
  sg lp -c 'python unyka_printer.py text "žluťoučký kůň" --czech --big'
  sg lp -c 'python unyka_printer.py image photo.jpg --contrast 1.4 --brightness 1.25'
  sg lp -c 'python unyka_printer.py cut [--full]'
  sg lp -c 'python unyka_printer.py raw 1b7412...'

Requires: pyusb (always), pillow (only for `image`).
"""
import argparse
import sys
import time

import usb.core
import usb.util

VENDOR, PRODUCT = 0x1FC9, 0x2016
WIDTH_DOTS = 576
CP_CZECH = 18  # CP852 via ESC t


class UnykaPrinter:
    """Connection + verified ESC/POS primitives for 1fc9:2016."""

    def __init__(self, timeout=3000):
        self.timeout = timeout
        self.dev = usb.core.find(idVendor=VENDOR, idProduct=PRODUCT)
        if self.dev is None:
            raise RuntimeError("printer 1fc9:2016 not found (plugged in?)")
        if self.dev.is_kernel_driver_active(0):
            self.dev.detach_kernel_driver(0)  # releases usblp
        self.dev.set_configuration()
        eps = self.dev.get_active_configuration().interfaces()[0].endpoints()
        self.out_ep = next(ep for ep in eps
                           if usb.util.endpoint_direction(ep.bEndpointAddress) == usb.util.ENDPOINT_OUT)
        self.in_ep = next(ep for ep in eps
                          if usb.util.endpoint_direction(ep.bEndpointAddress) == usb.util.ENDPOINT_IN)
        self.czech = True  # CP852 (Latin-2) default — safe for pure-ASCII text too

    def send(self, data, timeout=None):
        """Send str (cp437-mapped control text) or bytes/list of raw bytes."""
        raw = bytes(data, "cp437", "replace") if isinstance(data, str) else bytes(data)
        self.out_ep.write(raw, timeout or self.timeout)

    def _read(self, n=64, timeout=None):
        try:
            return bytes(self.in_ep.read(n, timeout or self.timeout))
        except usb.core.USBError:
            return None

    # --- basics -------------------------------------------------------
    def init(self):
        self.send([0x1B, 0x40])  # ESC @ (resets formatting AND codepage!)
        if self.czech:
            self.set_czech()     # ESC @ dropped codepage back to CP437 — re-select

    def set_czech(self):
        self.send([0x1B, 0x74, CP_CZECH])  # ESC t 18 → CP852

    def text(self, s, big=False, center=False, bold=False, newline=True):
        """Print text. Czech (CP852) is default; set self.czech=False for CP437."""
        if center:
            self.send([0x1B, 0x61, 1])
        if big:
            self.send([0x1D, 0x21, 1, 1])
        if bold:
            self.send([0x1B, 0x45, 1])
        self.send(s.encode("cp852") if self.czech else s.encode("cp437", "replace"))
        if newline:
            self.send(b"\n")
        if bold:
            self.send([0x1B, 0x45, 0])
        if big:
            self.send([0x1D, 0x21, 0, 0])
        if center:
            self.send([0x1B, 0x61, 0])

    def feed(self, lines=1):
        self.send([0x1B, 0x64, min(lines, 4)])  # firmware clamps ~4

    def cut(self, full=False):
        """Partial cut by default (full leaves a stub too). No feed needed."""
        if full:
            self.send([0x1D, 0x56, 0x00])          # GS V 0 full cut
        else:
            self.send([0x1D, 0x56, 0x42, 0x00])    # GS V B 0 partial cut

    # --- status -------------------------------------------------------
    def status(self, verbose=True):
        """DLE EOT 1-4 real-time queries. Returns dict."""
        def q(n):
            # the first query after opening the connection often gets no
            # response (endpoint warm-up) — retry once
            self.send([0x10, 0x04, n])
            r = self._read(1)
            if r is None:
                time.sleep(0.2)
                self.send([0x10, 0x04, n])
                r = self._read(1)
            return r[0] if r else None

        s = q(1)   # printer status: bit3=1 means off-line
        st = {
            "raw_status1": s,
            "online": None if s is None else not (s & 0x08),
        }
        st["error_status"] = q(3)   # 0x12 = no error
        st["paper_status"] = q(4)   # 0x12 = paper present both sensors
        self.send([0x1B, 0x76])     # ESC v paper roll
        st["esc_v_paper"] = self._read(1)
        if verbose:
            ok = st["error_status"] == 0x12
            paper_ok = st["esc_v_paper"] == b"\x00"
            print(f"online:        {st['online']}")
            print(f"error status:  {hex(st['error_status']) if st['error_status'] is not None else None} ({'OK' if ok else 'check!'})")
            print(f"paper present: {'yes' if paper_ok else 'NO / unknown'} ({st['esc_v_paper']})")
        return st

    # --- images -------------------------------------------------------
    def print_image(self, path, contrast=1.4, brightness=1.25, dither=True):
        """Resize to full width, dither, print via GS v 0.
        contrast/brightness defaults are the paper-verified best variant."""
        from PIL import Image, ImageEnhance, ImageOps
        img = Image.open(path)
        img = ImageOps.autocontrast(img.convert("L"))
        img = img.resize((WIDTH_DOTS, img.height * WIDTH_DOTS // img.width), Image.LANCZOS)
        if contrast != 1.0:
            img = ImageEnhance.Contrast(img).enhance(contrast)
        if brightness != 1.0:
            img = ImageEnhance.Brightness(img).enhance(brightness)
        img = img.convert("1") if dither else img.point(lambda p: 0 if p < 128 else 255, "1")

        w_bytes = WIDTH_DOTS // 8
        h = img.height
        data = bytearray()
        px = img.load()
        for y in range(h):
            for xb in range(w_bytes):
                b = 0
                for bit in range(8):
                    if px[xb * 8 + bit, y] == 0:  # 0 = black in mode '1'
                        b |= 0x80 >> bit
                data.append(b)
        # flow control: the receive buffer only holds tens of KB; overflowing
        # it makes the firmware misinterpret raster data as commands (prints
        # garbage and hangs).
        #
        # This firmware answers DLE EOT only when the whole pending command
        # (a COMPLETE raster) is consumed — never mid-raster (polling inside
        # a multi-chunk image returns nothing until the very last byte). So
        # the handshake unit is a whole
        # self-contained GS v 0 block: send image as ≤8 KB strips (113 full
        # rows each, safely below the buffer size), poll until response,
        # immediately send the next strip — the printhead keeps running and
        # no fixed sleeps are needed.
        #
        # Warm-up poll MUST precede the first GS v 0 header: a header without
        # immediately following data wedges the firmware (it ignores DLE EOT
        # while raster bytes are missing, and eventually dumps the buffer as
        # garbage; completing the pending raster un-wedges it).
        payload = bytes(data)
        STRIP_ROWS = 113                  # 113 * 72 = 8136 bytes per strip
        self._wait_ready()                # warm-up (first query needs retry)
        for y0 in range(0, h, STRIP_ROWS):
            rows = min(STRIP_ROWS, h - y0)
            self.send([0x1D, 0x76, 0x30, 0x00, w_bytes & 0xFF, w_bytes >> 8,
                       rows & 0xFF, rows >> 8])
            self.send(payload[y0 * w_bytes:(y0 + rows) * w_bytes])
            self._wait_ready()            # handshake: strip consumed → next
        self.send(b"\n")
        return h

    def _wait_ready(self, timeout=15.0):
        """Block until the printer's receive buffer is drained.

        Sends DLE EOT 1 repeatedly; response presence is the drained
        signal (no busy bit exists — see print_image)."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.send([0x10, 0x04, 1])
            if self._read(1, 200) is not None:
                return
        raise RuntimeError("printer stopped answering DLE EOT (buffer never drained?)")

    # --- convenience ----------------------------------------------------
    def czech_line(self, s, **kw):
        """init + CP852 + text in one call (safe preamble for Czech jobs)."""
        self.init()
        self.set_czech()
        self.czech = True
        self.text(s, **kw)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status")

    p = sub.add_parser("text")
    p.add_argument("message")
    p.add_argument("--czech", action="store_true", help="(default; kept for compat) ESC t 18 + cp852")
    p.add_argument("--no-czech", action="store_true", help="plain CP437 instead of CP852")
    p.add_argument("--big", action="store_true", help="2x2 scale")
    p.add_argument("--bold", action="store_true")
    p.add_argument("--center", action="store_true")
    p.add_argument("--no-cut", action="store_true", help="leave paper continuous")

    p = sub.add_parser("image")
    p.add_argument("path")
    p.add_argument("--contrast", type=float, default=1.4)
    p.add_argument("--brightness", type=float, default=1.25)
    p.add_argument("--no-dither", action="store_true")
    p.add_argument("--no-cut", action="store_true")

    p = sub.add_parser("cut")
    p.add_argument("--full", action="store_true")

    p = sub.add_parser("raw")
    p.add_argument("hexbytes", help="hex string, e.g. 1b40")

    args = ap.parse_args()
    pr = UnykaPrinter()

    if args.cmd == "status":
        pr.status()
    elif args.cmd == "text":
        pr.init()                 # ESC @ + re-selects CP852 when czech
        if args.no_czech:
            pr.czech = False
        pr.text(args.message, big=args.big, bold=args.bold, center=args.center)
        if not args.no_cut:
            pr.feed(2)
            pr.cut()
    elif args.cmd == "image":
        h = pr.print_image(args.path, args.contrast, args.brightness, not args.no_dither)
        print(f"printed {WIDTH_DOTS}x{h} dots")
        if not args.no_cut:
            pr.cut()
    elif args.cmd == "cut":
        pr.cut(full=args.full)
    elif args.cmd == "raw":
        pr.send(bytes.fromhex(args.hexbytes.replace(" ", "")))
    time.sleep(0.3)


if __name__ == "__main__":
    main()
