import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const SCAN_DIR = '/sys/bus/hid/drivers/razermouse';
const STARTUP_RETRY_SEC = 2;
const HOTPLUG_DEBOUNCE_SEC = 1;
// While the mouse talks over one transport (cable or dongle), the sysfs node
// of the other transport lingers but reports raw 0. A pid reading 0 for
// longer than this is a ghost transport — dropped rather than held.
const GHOST_TIMEOUT_SEC = 30;
// sysfs exposes no change events for charge level/status (inotify only sees
// directory entries, not attribute values), so the only way to catch a
// charging flip quickly is to poll. razer-tray polls every 5 s; reading two
// tiny sysfs files twice per interface at that rate costs nothing.
const ACTIVE_POLL_SEC = 5;

// U+FE0E forces text presentation of the emoji: rendered as a monochrome
// glyph that inherits the label's foreground color instead of full-color emoji.
const BOLT = '⚡︎';

const DECODER = new TextDecoder();

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
    _init(settings) {
        super._init(0.0, 'Razer Battery');
        this._settings = settings;
        this._label = new St.Label({
            text: '🖱 …',
            style: 'font-size: 0.85em;',
        });
        // St.Bin fills the full button height and centers the label inside;
        // a bare label only centers within its own (smaller) allocation box.
        this.add_child(new St.Bin({
            child: this._label,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._lowNotified = {};
        this._lastKnown = {};
        this._timeoutId = null;
        this._debounceId = null;
        this._startupRetryId = null;
        this._monitorId = null;
        this._destroyed = false;

        // Deferred startup: the mouse may enumerate a few seconds after
        // login, so retry quickly until the first successful read, then
        // settle into the slow poll. Nothing runs on the startup path.
        this._startupRetryId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, STARTUP_RETRY_SEC, () => {
                if (!this._refresh()) {
                    this._startupRetryId = null;
                    this._startStartupRetry();
                    return GLib.SOURCE_REMOVE;
                }
                this._startSlowPoll();
                return GLib.SOURCE_REMOVE;
            });

        // Hotplug: any change in the driver directory (cable plug/unplug
        // adds or removes a device) refreshes immediately instead of
        // waiting for the next poll.
        this._monitor = null;
        try {
            this._monitor = Gio.File.new_for_path(SCAN_DIR).monitor_directory(
                Gio.FileMonitorFlags.NONE, null);
            this._monitorId = this._monitor.connect('changed',
                () => this._scheduleHotRefresh());
        } catch (e) {
            this._monitor = null; // sysfs watches unsupported — poll only
        }
    }

    _startStartupRetry() {
        if (this._startupRetryId !== null)
            return;
        this._startupRetryId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, STARTUP_RETRY_SEC, () => {
                this._startupRetryId = null;
                if (this._refresh()) {
                    this._startSlowPoll();
                    return GLib.SOURCE_REMOVE;
                }
                this._startStartupRetry();
                return GLib.SOURCE_REMOVE;
            });
    }

    _startSlowPoll() {
        this._removeTimeout('_timeoutId');
        const interval = this._anyDevicePresent()
            ? ACTIVE_POLL_SEC : this._settings.get_int('poll-seconds');
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, interval, () => {
                if (!this._refresh()) {
                    // All devices asleep — poll fast until one wakes up,
                    // otherwise the first reading after wake is delayed by
                    // a full slow interval.
                    this._removeTimeout('_timeoutId');
                    this._startStartupRetry();
                    return GLib.SOURCE_REMOVE;
                }
                this._startSlowPoll(); // re-pick interval after state change
                return GLib.SOURCE_REMOVE;
            });
    }

    _anyDevicePresent() {
        // True if the driver currently exposes at least one battery node
        // (device awake or ghost), i.e. polling at ACTIVE_POLL_SEC matters.
        try {
            const e = Gio.File.new_for_path(SCAN_DIR).enumerate_children(
                'standard::*', Gio.FileQueryInfoFlags.NONE, null);
            try {
                let info;
                while ((info = e.next_file(null)) !== null)
                    if (info.get_name().startsWith('0003:'))
                        return true;
            } finally {
                e.close(null);
            }
        } catch (e) {}
        return false;
    }

    _scheduleHotRefresh() {
        // Enumeration fires a burst of events — one refresh after the burst.
        // If no live device remains (e.g. everything went idle), fall back
        // to fast retries until one reappears.
        if (this._debounceId !== null)
            return;
        this._debounceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, HOTPLUG_DEBOUNCE_SEC, () => {
                this._debounceId = null;
                if (this._refresh()) {
                    if (this._timeoutId === null)
                        this._startSlowPoll();
                } else {
                    this._removeTimeout('_timeoutId');
                    this._startStartupRetry();
                }
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
        const now = GLib.get_monotonic_time();
        // Hold the last known charge while a device sleeps (sysfs reads 0).
        // A node that has read 0 for a long time is a ghost transport (the
        // mouse moved to cable/dongle) — hold expires and it is dropped.
        for (const pid of pids) {
            if (devices[pid].level === 0 && this._lastKnown[pid]) {
                if (now - this._lastKnown[pid].seen < GHOST_TIMEOUT_SEC * 1000) {
                    devices[pid].level = this._lastKnown[pid].level;
                    devices[pid].charging = false; // asleep means not charging
                    devices[pid]._held = true;
                }
            } else if (devices[pid].level > 0) {
                this._lastKnown[pid] = {level: devices[pid].level, seen: now};
            }
        }
        // Drop devices that vanished entirely (unplugged), not just slept.
        for (const pid in this._lastKnown)
            if (!(pid in devices))
                delete this._lastKnown[pid];
        // Live = reported a fresh nonzero reading this cycle.
        const live = pids.filter(pid => devices[pid].level > 0 && !devices[pid]._held);
        for (const pid of pids)
            delete devices[pid]._held;
        const known = pids.filter(pid => devices[pid].level > 0);
        this._rebuildMenu(devices, known);
        if (known.length === 0 && pids.length === 0) {
            this._label.text = '🖱 —';
            return false;
        }
        if (known.length === 0) {
            // Driver bound but nothing has reported yet (mouse enumerating).
            this._label.text = '🖱 …';
            return false;
        }
        const parts = known.map(pid => {
            const d = devices[pid];
            this._trackLowBattery(pid, d);
            return formatDevice(d);
        });
        this._label.text = `🖱 ${parts.join(' ')}`;
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
        this._removeTimeout('_startupRetryId');
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
        this._indicator = new BatteryIndicator(this.getSettings());
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