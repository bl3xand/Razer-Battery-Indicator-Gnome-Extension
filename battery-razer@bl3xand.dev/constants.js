// Tunable constants for the indicator.

// Battery attributes do not emit value-change events in sysfs.
export const POLL_SEC = 30;
export const SLEEP_POLL_SEC = 120;

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
    'https://github.com/bl3xand/Razer-Battery#openrazer-driver';

// Raw script URL used by the in-menu installer button (curl | bash).
// Only included in the Git/local package; the store ships a help-only action.
export const DRIVER_SETUP_RAW =
    'https://raw.githubusercontent.com/bl3xand/Razer-Battery/main/install-driver.sh';

// U+FE0E forces text presentation of the emoji: rendered as a monochrome
// glyph that inherits the label's foreground color instead of full-color
// emoji. Used for the charging bolt.
export const BOLT = '⚡︎';