# Razer Mouse Battery Indicator — GNOME Shell Extension

Shows the battery level of a Razer wireless mouse (via the OpenRazer kernel
driver) directly in the GNOME top panel.

![screenshot](screenshot.png)

## Features

- Mouse icon + percentage label in the top panel, always one entry per device
- The icon is drawn from an embedded vector path and recolors itself for
  light/dark panel themes — no image assets
- Deduplication: a mouse exposes several HID battery interfaces — the
  extension groups them by device and takes the best nonzero reading
- Dead connections (e.g. the dongle while the mouse is charging over cable)
  are hidden automatically
- ⚡ charging indicator (monochrome, follows text color)
- Sleep-aware: while the mouse sleeps (sysfs reads 0) the last known charge
  is held instead of dropping the indicator
- Low-battery notification at 20% (configurable)
- 5 s polling, zero background processes (runs inside GNOME Shell)
- Driver-missing detection: if the OpenRazer kernel driver is absent, the
  indicator shows `!` and the menu links to the setup instructions below

## Install

```bash
git clone https://github.com/bl3xand/Razer-Battery-Indicator-Gnome-Extension.git
cp -r Razer-Battery-Indicator-Gnome-Extension/battery-razer@bl3xand.dev ~/.local/share/gnome-shell/extensions/
gnome-extensions enable battery-razer@bl3xand.dev
```

On Wayland, log out and back in first so GNOME Shell discovers the extension.

Or grab the package from **extensions.gnome.org** (search "Razer Battery").

## Requirements

- GNOME Shell 50 or 51

The OpenRazer kernel driver is the only dependency. It cannot be bundled
inside the extension (it is an out-of-tree kernel module), but setup is one
command — see below. If the driver is missing, the extension tells you
instead of silently failing.

## <a name="openrazer-driver"></a>OpenRazer driver

The extension reads `/sys/bus/hid/drivers/razermouse/*/charge_level`
(raw 0–255, 255 = 100%) exposed by the driver.

**One-command install** — detects your distro, installs the driver and
adds your user to the right group:

```bash
curl -fsSL https://raw.githubusercontent.com/bl3xand/Razer-Battery-Indicator-Gnome-Extension/main/install-driver.sh | bash
```

What it does per distro:

| Distro | Package | Group |
|---|---|---|
| Arch (and derivatives) | `openrazer-driver-dkms` + `linux-headers` | `openrazer` |
| Fedora | `openrazer-meta` from the `hardware:razer` repo | `plugdev` |
| Ubuntu | `openrazer-driver-dkms` (universe) | `plugdev` |
| Debian | `openrazer-driver-dkms` | `plugdev` |
| openSUSE | `openrazer-driver-dkms` from `hardware:razer` | `plugdev` |

**Reboot after install** — the kernel module and the group permission only
take effect after a reboot. Secure Boot may block the unsigned module; see
the [OpenRazer troubleshooting guide](https://github.com/openrazer/openrazer/wiki/Troubleshooting).

Other distros: see the [official OpenRazer instructions](https://openrazer.github.io/).

## Tested on

- Arch Linux (GNOME Shell 50.5, OpenRazer 3.12.4, Razer Basilisk V3 Pro 35K)

Found a problem on your system? **Please open an
[issue](https://github.com/bl3xand/Razer-Battery-Indicator-Gnome-Extension/issues)** —
include your distro, GNOME Shell version and the output of
`journalctl -b /usr/bin/gnome-shell | grep battery-razer`.

## Uninstall

```bash
gnome-extensions disable battery-razer@bl3xand.dev
rm -r ~/.local/share/gnome-shell/extensions/battery-razer@bl3xand.dev
```

## License

MIT