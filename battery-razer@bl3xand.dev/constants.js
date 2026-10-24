// Tunable constants for the indicator.

// sysfs exposes no change events for charge level/status (inotify only
// sees directory entries, not attribute values), so the only way to catch
// a charging flip quickly is to poll. razer-tray model: one flat interval
// for everything (awake, asleep, charging) — 5 s reading two tiny files
// costs nothing, and a single constant means no timer-state machine to
// get wrong.
export const POLL_SEC = 5;

// Hotplug events (device add/remove in the driver directory) arrive in
// bursts — one refresh this long after the last event.
export const HOTPLUG_DEBOUNCE_SEC = 1;

// Panel icon size, matches the system-status-icon class.
export const ICON_PX = 16;

// Verbose logging to the journal (journalctl -f /usr/bin/gnome-shell |
// grep battery-razer). Flip to true when diagnosing behavior.
export const DEBUG = false;

// Where the openrazer kernel driver exposes battery interfaces.
export const SCAN_DIR = '/sys/bus/hid/drivers/razermouse';

// Shown in the menu when the kernel driver is missing: repo page with the
// one-command installer script (install-driver.sh).
export const DRIVER_SETUP_URL =
    'https://github.com/bl3xand/Razer-Battery-Indicator-Gnome-Extension#openrazer-driver';

// U+FE0E forces text presentation of the emoji: rendered as a monochrome
// glyph that inherits the label's foreground color instead of full-color
// emoji. Used for the charging bolt.
export const BOLT = '⚡︎';