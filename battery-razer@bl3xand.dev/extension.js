import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const SCAN_DIR = '/sys/bus/hid/drivers/razermouse';
const POLL_SEC = 60;
const LOW_THRESHOLD = 20;

const DECODER = new TextDecoder();

// All battery interfaces grouped by device (0003:1532:00D7 etc). A device
// exposes several interfaces reporting the same battery: take the best
// nonzero reading — idle interfaces return raw 0 = no data.
function readBatteries() {
    const devices = {};
    let enumerator = null;
    try {
        enumerator = Gio.File.new_for_path(SCAN_DIR).enumerate_children(
            'standard::*', Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        return devices; // driver not loaded — no Razer devices
    }
    try {
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const id = info.get_name(); // 0003:1532:00D7.0004
            if (!id.startsWith('0003:'))
                continue;
            const base = `${SCAN_DIR}/${id}`;
            if (!Gio.File.new_for_path(`${base}/charge_level`).query_exists(null))
                continue;
            const pid = id.substring(0, id.lastIndexOf('.'));
            if (!devices[pid])
                devices[pid] = { level: 0, charging: false };
            const level = readInt(`${base}/charge_level`);
            if (level !== null && level > devices[pid].level)
                devices[pid].level = level; // raw 0-255
            if (readInt(`${base}/charge_status`) === 1)
                devices[pid].charging = true;
        }
    } finally {
        enumerator.close(null);
    }
    // drop dead devices (all interfaces report 0 = device not talking)
    const out = {};
    for (const pid in devices)
        if (devices[pid].level > 0)
            out[pid] = devices[pid];
    return out;
}

function readInt(path) {
    try {
        const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
        return parseInt(DECODER.decode(bytes), 10);
    } catch (e) {
        return null;
    }
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
        // defer the first read off the startup path; retry fast until the
        // mouse enumerates (USB/driver can lag a few seconds after login),
        // then settle into the slow poll
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            const found = this._refresh();
            if (!found) {
                return GLib.SOURCE_CONTINUE; // keep retrying every 2 s
            }
            this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SEC, () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _refresh() {
        const devices = readBatteries();
        const names = Object.keys(devices);
        if (names.length === 0) {
            this._label.text = '🖱 —';
            return false;
        }
        const parts = names.map(pid => {
            const d = devices[pid];
            const pct = Math.round(d.level * 100 / 255);
            if (pct <= LOW_THRESHOLD && !d.charging && !this._lowNotified[pid]) {
                this._lowNotified[pid] = true;
                Main.notify('Razer: батарея садится', `${pct}% — пора на зарядку`);
            }
            if (pct > LOW_THRESHOLD)
                this._lowNotified[pid] = false;
            return d.charging ? `${pct}% ⚡` : `${pct}%`;
        });
        this._label.text = `🖱 ${parts.join(' ')}`;
        return true;
    }

    vfunc_destroy() {
        // stop the poll timer before the actor is torn down
        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
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