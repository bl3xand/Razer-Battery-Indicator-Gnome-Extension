import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const SCAN_DIR = '/sys/bus/hid/drivers/razermouse';
const POLL_SEC = 60;
const STARTUP_RETRY_SEC = 2;
const HOTPLUG_DEBOUNCE_SEC = 1;
const LOW_THRESHOLD = 20;

const DECODER = new TextDecoder();

/**
 * Read every battery interface exposed by the openrazer kernel driver and
 * group it by device (the sysfs id looks like 0003:1532:00D7.0004 — the part
 * before the last dot identifies the physical device).
 *
 * A device exposes several interfaces reporting the same battery: keep the
 * best nonzero reading, since idle interfaces return raw 0 = no data.
 * Devices whose every interface reports 0 are not talking (e.g. the dongle
 * while the mouse charges over cable) and are dropped entirely.
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
            if (readInt(`${base}/charge_status`) === 1)
                device.charging = true;
        }
    } finally {
        enumerator.close(null);
    }
    const live = {};
    for (const pid in devices)
        if (devices[pid].level > 0)
            live[pid] = devices[pid];
    return live;
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

/** One panel entry per live device: "100%" or "85% ⚡" (gold bolt). */
function formatDevice(device) {
    const pct = Math.round(device.level * 100 / 255);
    const bolt = device.charging ? ' ⚡' : '';
    return `${pct}%${bolt}`;
}

const BatteryIndicator = GObject.registerClass(
class BatteryIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Razer Battery');
        this._label = new St.Label({
            text: '🖱 …',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 0.85em;',
            });
        this.add_child(this._label);
        this._lowNotified = {};
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
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, POLL_SEC, () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _scheduleHotRefresh() {
        // Enumeration fires a burst of events — one refresh after the burst
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

    /** @returns {boolean} whether any live device was found */
    _refresh() {
        if (this._destroyed)
            return false;
        const devices = readBatteries();
        const pids = Object.keys(devices);
        if (pids.length === 0) {
            this._label.text = '🖱 —';
            return false;
        }
        const parts = pids.map(pid => {
            const d = devices[pid];
            this._trackLowBattery(pid, d);
            return formatDevice(d);
        });
        this._label.text = `🖱 ${parts.join(' ')}`;
        return true;
    }

    _trackLowBattery(pid, device) {
        const pct = Math.round(device.level * 100 / 255);
        if (pct <= LOW_THRESHOLD && !device.charging) {
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

export default class RazerBatteryExtension {
    enable() {
        this._indicator = new BatteryIndicator();
        Main.panel.addToStatusArea('battery-razer', this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}