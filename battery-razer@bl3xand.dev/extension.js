const St = imports.gi.St;
const Main = imports.ui.main;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Clutter = imports.gi.Clutter;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const SCAN_DIR = '/sys/bus/hid/drivers/razermouse';
const POLL_SEC = 30;
const LOW_THRESHOLD = 20;

// All battery interfaces grouped by device (0003:1532:00D7 etc). A device
// exposes several interfaces reporting the same battery: take the best
// nonzero reading — idle interfaces return raw 0 = no data.
function readBatteries() {
    const devices = {};
    let dir;
    try {
        dir = Gio.File.new_for_path(SCAN_DIR).enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) { return devices; }
    let info;
    while ((info = dir.next_file(null)) !== null) {
        const id = info.get_name(); // 0003:1532:00D7.0004
        if (!id.startsWith('0003:'))
            continue;
        const base = `${SCAN_DIR}/${id}`;
        if (!Gio.File.new_for_path(`${base}/charge_level`).query_exists(null))
            continue;
        const pid = id.substring(0, id.lastIndexOf('.'));
        if (!devices[pid])
            devices[pid] = { level: 0, charging: false };
        const read = (p) => {
            try {
                return parseInt(imports.byteArray.toString(Gio.File.new_for_path(p).load_contents(null)[1]), 10);
            } catch (e) { return null; }
        };
        const level = read(`${base}/charge_level`);
        if (level !== null && level > devices[pid].level)
            devices[pid].level = level; // raw 0-255
        if (read(`${base}/charge_status`) === 1)
            devices[pid].charging = true;
    }
    // drop dead devices (all interfaces report 0 = device not talking)
    const out = {};
    for (const pid in devices)
        if (devices[pid].level > 0)
            out[pid] = devices[pid];
    return out;
}

const BatteryIndicator = GObject.registerClass(
class BatteryIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Razer Battery');
        this._label = new St.Label({ text: '🖱 …', y_align: Clutter.ActorAlign.CENTER });
        this.add_child(this._label);
        this._lowNotified = {};
        this._refresh();
        this._timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SEC, () => { this._refresh(); return GLib.SOURCE_CONTINUE; });
    }

    _refresh() {
        const devices = readBatteries();
        const names = Object.keys(devices);
        if (names.length === 0) {
            this._label.text = '🖱 —';
            return;
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
    }

    destroy() {
        if (this._timeout)
            GLib.source_remove(this._timeout);
        this._timeout = null;
        super.destroy();
    }
});

class Extension {
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

function init() { return new Extension(); }
