"""Build and flash one board, then optionally watch its serial log.

    python tools/flash.py 1            # buoy #1 (real sensors, 2 s demo sampling)
    python tools/flash.py 2 --port COM4
    python tools/flash.py 3 --erase    # wipe flash first: forgets stored records and seq numbers
    python tools/flash.py buoy -m      # any PlatformIO env name works; -m opens the monitor after

Stop the server first if it has the port open (it does for the collector base).
Needs PlatformIO in the active environment: pip install platformio
"""
import argparse
import subprocess
import sys
from pathlib import Path

from serial.tools import list_ports

ROOT = Path(__file__).resolve().parent.parent
BOARDS = {  # board number -> (env, what it is, monitor baud)
    "1": ("buoy_demo", "buoy #1 f4e618b4, real sensors", 115200),
    "2": ("collector", "collector base #2 f4e5cbbc", 921600),
    "3": ("buoy_sim", "buoy #3 f4e5f71c, simulated sensors", 115200),
}
USB_SERIAL_VIDS = {0x10C4, 0x1A86, 0x0403, 0x303A}  # CP210x, CH340, FTDI, Espressif native USB


def pick_port() -> str:
    ports = [p for p in list_ports.comports() if p.vid in USB_SERIAL_VIDS]
    if len(ports) == 1:
        return ports[0].device
    if not ports:
        sys.exit("No ESP32 found on USB. Plug it in (data cable, not charge-only) or pass --port.")
    listing = "\n".join(f"  {p.device}  {p.description}" for p in ports)
    sys.exit(f"Several boards connected; pick one with --port:\n{listing}")


def pio(*args: str) -> None:
    cmd = [sys.executable, "-m", "platformio", *args]
    print(">", " ".join(cmd[2:]), flush=True)
    if subprocess.call(cmd, cwd=ROOT):
        sys.exit(1)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("board", help="1, 2, 3, or a PlatformIO env name")
    ap.add_argument("--port", "-p", help="serial port, e.g. COM4 (auto-detected if only one board is plugged in)")
    ap.add_argument("--erase", action="store_true", help="erase the whole flash before uploading")
    ap.add_argument("--monitor", "-m", action="store_true", help="open the serial monitor after flashing")
    a = ap.parse_args()

    env, what, baud = BOARDS.get(a.board, (a.board, a.board, 115200))
    if subprocess.call([sys.executable, "-m", "platformio", "--version"], cwd=ROOT, stdout=subprocess.DEVNULL):
        sys.exit("PlatformIO isn't installed in this Python: pip install platformio")
    port = a.port or pick_port()
    print(f"Flashing {what} (env {env}) on {port}")
    if a.erase:
        pio("run", "-e", env, "-t", "erase", "--upload-port", port)
    pio("run", "-e", env, "-t", "upload", "--upload-port", port)
    if a.monitor:
        pio("device", "monitor", "-p", port, "-b", str(baud))


if __name__ == "__main__":
    main()
