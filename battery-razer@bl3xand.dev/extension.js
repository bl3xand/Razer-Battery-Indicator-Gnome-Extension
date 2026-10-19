import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const SCAN_DIR = '/sys/bus/hid/drivers/razermouse';
const HOTPLUG_DEBOUNCE_SEC = 1;
// Verbose logging to the journal (journalctl -f /usr/bin/gnome-shell |
// grep battery-razer). Flip to true when diagnosing behavior.
const DEBUG = false;
// razer-tray model: one flat interval for everything (awake, asleep,
// charging). sysfs exposes no change events, so polling is the only way;
// 5 s reading two tiny files costs nothing, and a single constant means
// no timer-state machine to get wrong.
const POLL_SEC = 5;
// Panel icon size, matches the system-status-icon class.
const ICON_PX = 16;

// U+FE0E forces text presentation of the emoji: rendered as a monochrome
// glyph that inherits the label's foreground color instead of full-color emoji.
const BOLT = '⚡︎';

const DECODER = new TextDecoder();

/** Debug log, greppable in the journal as "battery-razer". */
function debug(...args) {
    if (DEBUG)
        console.log(`battery-razer: ${args.join(' ')}`);
}

/**
 * Read every battery interface exposed by the openrazer kernel driver and
 * group it by device (the sysfs id looks like 0003:1532:00D7.0004 — the part
 * before the last dot identifies the physical device).
 *
 * A device exposes several interfaces reporting the same battery: keep the
 * best nonzero reading, since idle interfaces return raw 0 = no data.
 * A device whose every interface reads 0 is asleep (or idle) — it is still
 * returned so the caller can hold its last known charge.
 *
 * @returns {Record<string, {level: number, charging: boolean}>} raw level 0-255
 */
function readBatteries() {
    const devices = {};
    let enumerator;
    try {
        enumerator = Gio.File.new_for_path(SCAN_DIR).enumerate_children(
            'standard::*', Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        return devices; // driver not loaded — no Razer devices
    }
    try {
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const id = info.get_name();
            if (!id.startsWith('0003:'))
                continue;
            const base = `${SCAN_DIR}/${id}`;
            if (!Gio.File.new_for_path(`${base}/charge_level`).query_exists(null))
                continue;
            const pid = id.substring(0, id.lastIndexOf('.'));
            const device = devices[pid] ??= {level: 0, charging: false};
            const level = readInt(`${base}/charge_level`);
            if (level !== null && level > device.level)
                device.level = level;
            const status = readInt(`${base}/charge_status`);
            if (status !== null)
                device.charging = status === 1;
        }
    } finally {
        enumerator.close(null);
    }
    return devices;
}

/** Read a whole sysfs file and parse it as an integer, null on any failure. */
function readInt(path) {
    try {
        const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
        return parseInt(DECODER.decode(bytes), 10);
    } catch (e) {
        return null;
    }
}

/** One panel entry per live device: "100%" or "85% ⚡". */
function formatDevice(device) {
    const pct = Math.round(device.level * 100 / 255);
    const bolt = device.charging ? ` ${BOLT}` : '';
    return `${pct}%${bolt}`;
}

const BatteryIndicator = GObject.registerClass(
class BatteryIndicator extends PanelMenu.Button {
    _init(settings, iconsDir) {
        super._init(0.0, 'Razer Battery');
        this._settings = settings;
        // Icon: the bundled vector mouse (icons/icon-mouse-symbolic.svg),
        // rasterized once via GdkPixbuf and drawn through St.DrawingArea.
        // Cairo paints it with the panel's foreground color (read from the
        // theme node at repaint time), so the silhouette follows the theme —
        // self-contained, no icon-theme installation needed. The pixbuf's
        // alpha channel is the mask. Fallback: 🖱 emoji when SVG missing.
        this._iconPixbuf = null;
        const svg = `${iconsDir}/icon-mouse-symbolic.svg`;
        if (Gio.File.new_for_path(svg).query_exists(null)) {
            try {
                this._iconPixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(
                    svg, ICON_PX, ICON_PX);
            } catch (e) {
                this._iconPixbuf = null;
            }
        }
        this._label = new St.Label({
            text: this._iconPixbuf ? '…' : '🖱 …',
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
            style: 'font-size: 0.85em; margin: 0 2px;',
        });
        const box = new St.BoxLayout({vertical: false});
        if (this._iconPixbuf) {
            const icon = new St.DrawingArea();
            icon.set_size_request(ICON_PX, ICON_PX);
            icon.connect('repaint', (area) => this._paintIcon(area));
            box.add_child(icon);
        }
        box.add_child(this._label);
        // BoxLayout fills the full button height; children center inside.
        box.y_expand = true;
        this.add_child(box);
        this._lowNotified = {};
        this._lastKnown = {};
        this._timeoutId = null;
        this._debounceId = null;
        this._monitorId = null;
        this._destroyed = false;

        // Single flat poll, razer-tray style: one interval for awake,
        // asleep and no-devices alike. First refresh runs right here so
        // the indicator is populated without waiting a cycle.
        this._refresh();
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, POLL_SEC, () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });

        // Hotplug: any change in the driver directory (cable plug/unplug
        // adds or removes a device) refreshes immediately instead of
        // waiting for the next poll.
        this._monitor = null;
        try {
            this._monitor = Gio.File.new_for_path(SCAN_DIR).monitor_directory(
                Gio.FileMonitorFlags.NONE, null);
            this._monitorId = this._monitor.connect('changed',
                () => { debug('hotplug event'); this._scheduleHotRefresh(); });
        } catch (e) {
            this._monitor = null; // sysfs watches unsupported — poll only
        }
    }

    /** Paint the bundled mouse pixbuf with the panel foreground color. */
    _paintIcon(area) {
        const cr = area.get_context();
        const [ok, color] = area.get_theme_node().lookup_color('foreground', false);
        const fg = ok ? color
            : new Clutter.Color({red: 255, green: 255, blue: 255, alpha: 255});
        // The pixbuf becomes the mask; the solid theme color the paint.
        GdkPixbuf.cairo_set_source_pixbuf(cr, this._iconPixbuf, 0, 0);
        const pattern = cr.getSource();
        cr.setSourceRGBA(
            fg.red / 255, fg.green / 255, fg.blue / 255, fg.alpha / 255);
        cr.mask(pattern);
        cr.$dispose();
    }

    _scheduleHotRefresh() {
        // Enumeration fires a burst of events — one refresh after the burst.
        if (this._debounceId !== null)
            return;
        this._debounceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, HOTPLUG_DEBOUNCE_SEC, () => {
                this._debounceId = null;
                this._refresh();
                return GLib.SOURCE_REMOVE;
            });
    }

    _removeTimeout(prop) {
        if (this[prop] !== null) {
            GLib.source_remove(this[prop]);
            this[prop] = null;
        }
    }

    /** @returns {boolean} whether any device reported a fresh reading */
    _refresh() {
        if (this._destroyed)
            return false;
        const devices = readBatteries();
        const pids = Object.keys(devices);
        const t = new Date().toISOString().slice(11, 23);
        // Hold the last known charge while a device sleeps (sysfs reads 0).
        // The same physical mouse can appear via two transports (cable +
        // dongle): while one is live, a peer reading 0 is a ghost and is
        // NOT held; only when NOTHING is live do we hold (mouse is asleep).
        const livePids = pids.filter(pid => devices[pid].level > 0);
        for (const pid of pids) {
            if (devices[pid].level === 0 && this._lastKnown[pid] &&
                livePids.length === 0) {
                devices[pid].level = this._lastKnown[pid].level;
                devices[pid].charging = false; // asleep means not charging
                devices[pid]._held = true;
            } else if (devices[pid].level > 0) {
                this._lastKnown[pid] = {level: devices[pid].level};
            }
        }
        // Drop devices that vanished entirely (unplugged), not just slept.
        for (const pid in this._lastKnown)
            if (!(pid in devices)) {
                debug(t, `forget ${pid.slice(-4)} (node gone)`);
                delete this._lastKnown[pid];
            }
        // Live = reported a fresh nonzero reading this cycle.
        const live = pids.filter(pid => devices[pid].level > 0 && !devices[pid]._held);
        for (const pid of pids)
            delete devices[pid]._held;
        const known = pids.filter(pid => devices[pid].level > 0);
        debug(t,
            `raw [${pids.map(pid =>
                `${pid.slice(-4)}=${devices[pid].level}${devices[pid].charging ? ',chg' : ''}`
            ).join(' ')}]`,
            `shown [${known.map(pid => pid.slice(-4)).join(' ')}]`,
            live.length > 0 ? 'fresh' : 'held/asleep');
        this._rebuildMenu(devices, known);
        const pfx = this._iconPixbuf ? '' : '🖱 ';
        if (known.length === 0 && pids.length === 0) {
            this._label.text = `${pfx}—`;
            return false;
        }
        if (known.length === 0) {
            // Driver bound but nothing has reported yet (mouse enumerating).
            this._label.text = `${pfx}…`;
            return false;
        }
        const parts = known.map(pid => {
            const d = devices[pid];
            this._trackLowBattery(pid, d);
            return formatDevice(d);
        });
        this._label.text = `${pfx}${parts.join(' ')}`;
        return live.length > 0;
    }

    /** Rebuild the dropdown: one line per device + a quit item. */
    _rebuildMenu(devices, known) {
        this.menu.removeAll();
        const pids = known.length > 0 ? known : Object.keys(devices);
        if (pids.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                _('Устройства не найдены'), {reactive: false}));
        } else {
            for (const pid of pids) {
                const d = devices[pid];
                const pct = Math.round(d.level * 100 / 255);
                const item = new PopupMenu.PopupMenuItem(
                    `${this._deviceName(pid)} — ${pct}%` +
                    (d.charging ? ` ${BOLT}` : ''), {reactive: false});
                this.menu.addMenuItem(item);
            }
        }
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Выход'), () => this.destroy());
    }

    /** Map a sysfs pid to a readable device name. */
    _deviceName(pid) {
        const known = {
            '0003:1532:00D6': 'Basilisk V3 Pro 35K (провод)',
            '0003:1532:00D7': 'Basilisk V3 Pro 35K (dongle)',
        };
        return known[pid] ?? 'Razer ' + pid.split(':').pop();
    }

    _trackLowBattery(pid, device) {
        const pct = Math.round(device.level * 100 / 255);
        const threshold = this._settings.get_int('low-threshold');
        if (pct <= threshold && !device.charging) {
            if (!this._lowNotified[pid]) {
                this._lowNotified[pid] = true;
                Main.notify('Razer: батарея садится',
                    `${pct}% — пора на зарядку`);
            }
        } else {
            this._lowNotified[pid] = false;
        }
    }

    vfunc_destroy() {
        this._destroyed = true;
        this._removeTimeout('_timeoutId');
        this._removeTimeout('_debounceId');
        if (this._monitor) {
            if (this._monitorId)
                this._monitor.disconnect(this._monitorId);
            this._monitor.cancel();
            this._monitor = null;
        }
        super.vfunc_destroy();
    }
});

export default class RazerBatteryExtension extends Extension {
    enable() {
        this._indicator = new BatteryIndicator(
            this.getSettings(), `${this.path}/icons`);
        Main.panel.addToStatusArea('battery-razer', this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._settings = null;
    }
}