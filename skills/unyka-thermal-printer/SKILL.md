---
name: unyka-thermal-printer
description: >
  Print on the NXP-based ESC/POS thermal receipt printer (USB 1fc9:2016
  "USB Printer P", 80 mm paper). Use this skill whenever the user wants to
  print anything on a thermal printer or receipt printer — text, receipts,
  Czech diacritics, photos/images, logos, barcodes, QR codes — or asks about
  printer status, paper level, cutting, continuous printing, or connecting
  the printer via USB or Ethernet. Trigger on mentions of this printer,
  1fc9:2016, ESC/POS, usblp, /dev/usb/lp*, thermal printer, or phrases like
  "print this on the printer", "vytiskni na tiskárně", even when the printer
  is not explicitly named. This skill encodes hardware-verified facts
  (measurements on paper) about this specific printer that contradict both
  its own firmware reports and generic ESC/POS documentation.
---

# Unyka thermal printer (1fc9:2016)

80 mm ESC/POS receipt printer on an NXP MCU with OEM clone firmware.
Everything below was verified by printing and measuring on actual paper —
trust this document over the printer's own self-reports and over generic
ESC/POS references, because this firmware is a clone that both lacks features
and reports incorrect values.

## Critical facts (verified on paper)

| Fact | Value |
|---|---|
| Paper width | 80 mm, printhead 576 dots |
| Font A line width | **48 chars** (12×24 dots) |
| Font B line width | **64 chars** (9×17 dots, smaller glyphs, works incl. styles/scaling) |
| Czech language | ✅ `ESC t 18` (CP852) + text encoded as `.encode("cp852")` |
| Graphics | ✅ `GS v 0` raster, arbitrary bitmaps at full 576-dot width |
| Barcodes | ✅ CODE39, CODABAR, CODE128; ❌ EAN13, ITF |
| QR codes | ✅ `GS ( k` |
| Cut | ✅ partial `GS V B 0` and full `GS V 0`; full cut leaves a short stub |
| NV flash logo | ❌ unsupported (`GS ( L` fn80–84, `FS p` print garbage) |
| RAM logo | ✅ `GS *` + `GS /` (volatile, lost on power-off) |
| Buzzer | ❌ none of 7 known variants beeped |
| Status queries | ✅ `DLE EOT 1–4` (`0x12` = OK); ❌ `DLE EOT 5–7`; ⚠️ **no response while any command is pending** — response = the whole (complete) raster/command is consumed. Handshake works only *between* complete `GS v 0` blocks, never mid-raster |
| Font report `GS I 1` | ⚠️ **lies** (reports 32 chars/line; real is 48/64) |
| Feed `ESC d n` | ⚠️ clamped to ~4 lines max |

**Do not trust firmware self-reports — verify by printing and looking at the paper.**

## Environment setup

The device nodes are `root:lp 0660`, so commands must run with the `lp` group:

```bash
# one-time (admin): sudo usermod -aG lp <user>
# then run every command as:
sg lp -c '<command>'
```

Alternative persistent fix (requires admin):

```bash
echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="1fc9", ATTRS{idProduct}=="2016", MODE="0666"' | \
  sudo tee /etc/udev/rules.d/99-thermal-printer.rules
```

## Bundled script + venv (standalone)

`scripts/unyka_printer.py` is a self-contained CLI + library. It handles
device open (libusb, detaches the kernel `usblp` driver), init, Czech
codepage, and the verified quirks automatically.

Dependencies (`pyusb`, `pillow`) are vendored in the skill's own venv at
`.venv/` (git-ignored). If it is missing, recreate it:
`python3 -m venv .venv && .venv/bin/pip install pyusb pillow`
(or copy `usb/` + `PIL/` site-packages from any other venv of the same
Python version when offline).

Always invoke via the bundled venv — do NOT depend on a venv in whatever
project you happen to be in:

```bash
SKILL=~/.pi/agent/skills/unyka-thermal-printer
sg lp -c "$SKILL/.venv/bin/python $SKILL/scripts/unyka_printer.py status"
sg lp -c "$SKILL/.venv/bin/python $SKILL/scripts/unyka_printer.py text 'žluťoučký kůň' --czech --big"
sg lp -c "$SKILL/.venv/bin/python $SKILL/scripts/unyka_printer.py image photo.jpg --contrast 1.4 --brightness 1.25"
sg lp -c "$SKILL/.venv/bin/python $SKILL/scripts/unyka_printer.py cut"          # partial cut
sg lp -c "$SKILL/.venv/bin/python $SKILL/scripts/unyka_printer.py cut --full"
```

Subcommands: `status` (real-time status + paper), `text` (CP852 text; `--big`
double size, `--center`, `--bold`), `image` (resize to 576 px, autocontrast,
dither, print; tuned defaults `--contrast 1.4 --brightness 1.25` verified
best on this printer), `cut` (partial by default, `--full` for full cut),
`raw` (send hex bytes, for anything not covered).

As a library, import it (`from unyka_printer import UnykaPrinter`) and use the
same primitives for custom receipts/logs.

## Writing custom ESC/POS for this printer

Connection pattern (pyusb, no root needed once in `lp` group):

```python
import usb.core, usb.util
dev = usb.core.find(idVendor=0x1FC9, idProduct=0x2016)
if dev.is_kernel_driver_active(0):
    dev.detach_kernel_driver(0)
dev.set_configuration()
out_ep = next(ep for ep in dev.get_active_configuration().interfaces()[0].endpoints()
              if usb.util.endpoint_direction(ep.bEndpointAddress) == usb.util.ENDPOINT_OUT)
out_ep.write(bytes(data, "cp437", "replace") if isinstance(data, str) else bytes(data), 3000)
```

Recipe for Czech text (works; default CP437 has no Czech glyphs):

```python
send([0x1B, 0x40])            # ESC @ init
send([0x1B, 0x74, 18])        # ESC t 18 → CP852 (Czech)
send("ěščřžýáíé".encode("cp852"))
```

The codepage selection resets on `ESC @` and power cycle — re-select it in
every print job preamble.

Image pipeline (verified best-looking variant):

1. grayscale → `ImageOps.autocontrast` → resize to 576 px width (LANCZOS)
2. **contrast ×1.4 + brightness ×1.25** (plain autocontrast prints too dark)
3. `convert("1")` (Floyd-Steinberg dithering)
4. pack rows: MSB = leftmost dot, bit `1` = black, 72 bytes/row
5. `GS v 0 0 72 0 <hL> <hH>` + data; partial cut directly after data with no
   feed (`GS V B 0` does not damage the last printed rows)

**Never send a `GS v 0` header without immediately streaming all its data.**
A dangling header wedges the firmware: DLE EOT goes silent, and the buffer is
eventually dumped as garbage (completing the pending raster un-wedges it).
Also: polling `DLE EOT` mid-raster is useless — it stays silent until the
whole raster is consumed. So split images into self-contained strips of
~113 rows (8136 bytes, safely under the buffer size): warm up, then per
strip send `GS v 0` + data and poll until response, then the next strip.
`_wait_ready()` + the strip loop in `print_image` do exactly this.

Continuous printing (logs): simply never send `GS V`; paper tears by hand at
the tear bar. `ESC @` between records is safe (does not cut). For streaming
larger data, do NOT rely on fixed sleeps — the firmware answers `DLE EOT 1`
only when its receive buffer is empty, so poll-until-response is a reliable
"safe to send" handshake (`_wait_ready()` in the script does this).
Flow control by byte-level busy status is otherwise impossible: no CTS/RTS
on USB printer class, no busy bit, no ASB push observed.

## Capability matrix

| Area | Status |
|---|---|
| Text styles: bold `ESC E`, underline `ESC -`, inverse `GS B`, sizes `GS !` (2×, 3×), 90° `ESC V`, upside-down `ESC {` | ✅ both fonts |
| Absolute position `ESC $`, tab stops `ESC D`, line spacing `ESC 2/3` | ✅ |
| Codepages | ✅ CP437 (default), CP852 via `ESC t 18`; other sets untested |
| Barcodes with HRI text (`GS h/w/H/f`) | ✅ CODE39, CODABAR, CODE128 only |
| Raster graphics `GS v 0` | ✅ full width |
| QR `GS ( k` | ✅ |
| Cut `GS V B 0` / `GS V 0` | ✅ / ✅ (stub remains) |
| Model/fw query `GS I 49/50` | ✅ (model 0x20, fw 3) |
| Font B `ESC M 1` | ✅ works despite `GS I 1` not answering for it |
| EAN13, ITF, NV flash logos, buzzer, `DLE EOT 5–7`, `GS I 97` | ❌ |

## Ethernet

The printer also has an Ethernet port. Same ESC/POS byte stream works over
**raw TCP port 9100** (JetDirect) — just `socket.create_connection((ip, 9100))`
and send identical bytes. Discovery: WS-Discovery (UDP 3702), mDNS (5353).
IPP (631) / LPD (515) exist but clones are often minimal. Full details of the
original discovery session live in `~/projekty/unyka/UNYKA.md`.
