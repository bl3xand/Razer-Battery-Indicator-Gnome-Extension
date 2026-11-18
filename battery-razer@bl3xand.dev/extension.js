import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {POLL_SEC, SLEEP_POLL_SEC, HOTPLUG_DEBOUNCE_SEC, ICON_PX, SCAN_DIR, BOLT}
    from './constants.js';
import {paintMouse} from './mouseIcon.js';
import {BatteryReader} from './battery.js';
import {ActivityWatch} from './activity.js';
import {launchInstaller} from './actions.js';
import {debug} from './log.js';

/** One panel entry per live device: "100%" or "85% ⚡". */
function formatDevice(device) {
    const pct = Math.round(device.level * 100 / 255);
    const bolt = device.charging ? ` ${BOLT}` : '';
    return `${pct}%${bolt}`;
}

const BatteryIndicator = GObject.registerClass(
class BatteryIndicator extends PanelMenu.Button {
    _init(settings, uuid) {
        super._init(0.0, 'Razer Battery');
        this._settings = settings;
        // Use the panel foreground color, including custom themes.
        this._label = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
            style: 'font-size: 0.85em; margin: 0 2px;',
        });
        const box = new St.BoxLayout({vertical: false});
        const icon = new St.DrawingArea(
            {style: `width: ${ICON_PX}px; height: ${ICON_PX}px;`});
        // Children must both stretch to the box height AND center in it —
        // without y_align a Box child sticks to the top of the pill.
        icon.y_align = Clutter.ActorAlign.CENTER;
        icon.y_expand = true;
        this._icon = icon;
        this._repaintId = icon.connect('repaint', area => this._paintIcon(area));
        box.add_child(icon);
        box.add_child(this._label);
        // BoxLayout fills the full button height; children center inside.
        box.y_expand = true;
        this.add_child(box);
        this._uuid = uuid;
        this._lowNotified = {};
        this._lastKnown = {};
        this._driverMissing = false;
        this._installRequested = false;
        this._reading = false;
        this._refreshQueued = false;
        this._timeoutId = 0;
        this._debounceId = 0;
        this._monitorId = 0;
        this._monitor = null;
        this._driverWatchId = 0;
        this._driverWatch = null;
        this._menuKey = null;
        this._cancellable = new Gio.Cancellable();
        this._reader = new BatteryReader();
        this._activity = new ActivityWatch(global.backend, () => this._refreshOnActivity());
        this._watchDriver();
        this._refresh();
    }

    _watchDriver() {
        try {
            this._driverWatch = Gio.File.new_for_path('/sys/bus/hid/drivers')
                .monitor_directory(Gio.FileMonitorFlags.NONE, this._cancellable);
            this._driverWatchId = this._driverWatch.connect('changed', (monitor, file) => {
                if (file && file.get_basename() === 'razermouse')
                    this._scheduleHotRefresh();
            });
        } catch (error) {
            debug(`driver watch unavailable: ${error.message}`);
        }
    }

    _watchDevices() {
        if (this._monitor)
            return;
        try {
            this._monitor = Gio.File.new_for_path(SCAN_DIR)
                .monitor_directory(Gio.FileMonitorFlags.NONE, this._cancellable);
            this._monitorId = this._monitor.connect('changed', () => this._scheduleHotRefresh());
        } catch (error) {
            debug(`device watch unavailable: ${error.message}`);
        }
    }

    _paintIcon(area) {
        const cr = area.get_context();
        try {
            paintMouse(cr, area.width, area.get_theme_node().get_foreground_color());
        } finally {
            cr.$dispose();
        }
    }

    _scheduleHotRefresh() {
        if (!this._cancellable || this._cancellable.is_cancelled() || this._debounceId)
            return;
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._debounceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, HOTPLUG_DEBOUNCE_SEC, () => {
                this._debounceId = 0;
                this._refresh();
                return GLib.SOURCE_REMOVE;
            });
    }

    _refreshOnActivity() {
        if (!this._cancellable || this._cancellable.is_cancelled() || this._driverMissing)
            return;
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._debounceId) {
            GLib.Source.remove(this._debounceId);
            this._debounceId = 0;
        }
        this._refresh();
    }

    _schedulePoll(seconds) {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._debounceId || !this._cancellable || this._cancellable.is_cancelled())
            return;
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._timeoutId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refresh() {
        const cancellable = this._cancellable;
        if (!cancellable || cancellable.is_cancelled())
            return;
        if (this._reading) {
            this._refreshQueued = true;
            return;
        }
        this._reading = true;
        this._refreshQueued = false;
        let delay = SLEEP_POLL_SEC;
        try {
            const devices = await this._reader.read();
            if (cancellable.is_cancelled())
                return;
            this._driverMissing = false;
            this._watchDevices();
            if (Object.values(devices).some(device => device.level > 0))
                delay = POLL_SEC;
            this._apply(devices);
        } catch (error) {
            if (cancellable.is_cancelled())
                return;
            if (error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                this._driverMissing = true;
                if (this._monitor) {
                    this._monitor.disconnect(this._monitorId);
                    this._monitorId = 0;
                    this._monitor.cancel();
                    this._monitor = null;
                }
                this._label.text = '!';
                this._menuKey = null;
                this._rebuildMenu({}, []);
            } else {
                debug(`battery read failed: ${error.message}`);
            }
        } finally {
            this._reading = false;
            if (!cancellable.is_cancelled()) {
                if (this._refreshQueued)
                    this._refresh();
                else if (!this._driverMissing || !this._driverWatch)
                    this._schedulePoll(delay);
            }
        }
    }

    /** Pure state application — no I/O, safe to call directly. */
    _apply(devices) {
        const pids = Object.keys(devices);
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
            } else if (devices[pid].level > 0) {
                this._lastKnown[pid] = {level: devices[pid].level};
            }
        }
        // Drop devices that vanished entirely (unplugged), not just slept.
        for (const pid in this._lastKnown)
            if (!(pid in devices)) {
                delete this._lastKnown[pid];
                delete this._lowNotified[pid];
            }
        const known = pids.filter(pid => devices[pid].level > 0);
        // Menu is rebuilt only when the state actually changed — rebuilding
        // every cycle would churn actors for nothing.
        const menuKey = this._driverMissing
            ? (this._installRequested ? 'installed' : 'missing')
            : 'dev:' + (known.length === 0 ? 'none'
                : pids.map(pid =>
                    `${pid}:${devices[pid].level}:${devices[pid].charging ? 1 : 0}`)
                    .join('|'));
        if (menuKey !== this._menuKey) {
            this._menuKey = menuKey;
            this._rebuildMenu(devices, known);
        }
        if (pids.length === 0) {
            // Driver bound but no devices: unplugged or still enumerating.
            this._label.text = '—';
            return;
        }
        if (known.length === 0) {
            // Driver bound but nothing has reported yet (mouse enumerating).
            this._label.text = '…';
            return;
        }
        this._label.text = known.map(pid => {
            this._trackLowBattery(pid, devices[pid]);
            return formatDevice(devices[pid]);
        }).join(' ');
    }

    /** Rebuild the dropdown: one line per device + a quit item. */
    _rebuildMenu(devices, known) {
        this.menu.removeAll();
        const pids = known.length > 0 ? known : Object.keys(devices);
        if (this._driverMissing) {
            if (this._installRequested) {
                this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                    _('Finish setup in the terminal, then restart the computer'), {reactive: false}));
            } else {
                this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                    _('OpenRazer driver not installed'), {reactive: false}));
                this.menu.addAction(_('Driver setup'), async () => {
                    const cancellable = this._cancellable;
                    try {
                        const started = await launchInstaller(cancellable);
                        if (cancellable.is_cancelled())
                            return;
                        this._installRequested = started;
                        this._menuKey = null;
                        this._rebuildMenu({}, []);
                    } catch (error) {
                        if (!cancellable.is_cancelled())
                            Main.notifyError('Razer Battery', error.message);
                    }
                });
            }
        } else if (pids.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                _('No devices found'), {reactive: false}));
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
        this.menu.addAction(_('Quit'), () =>
            Main.extensionManager.disableExtension(this._uuid));
    }

    /** Map a sysfs pid to a readable device name. */
    _deviceName(pid) {
        const known = {
            '0003:1532:00D6': 'Basilisk V3 Pro 35K (wired)',
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
                Main.notify('Razer: battery low',
                    `${pct}% — time to charge`);
            }
        } else {
            this._lowNotified[pid] = false;
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._cancellable = null;
        this._activity.destroy();
        this._activity = null;
        this._reader.destroy();
        this._reader = null;
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._debounceId) {
            GLib.Source.remove(this._debounceId);
            this._debounceId = 0;
        }
        if (this._driverWatch) {
            this._driverWatch.disconnect(this._driverWatchId);
            this._driverWatchId = 0;
            this._driverWatch.cancel();
            this._driverWatch = null;
        }
        if (this._monitor) {
            this._monitor.disconnect(this._monitorId);
            this._monitorId = 0;
            this._monitor.cancel();
            this._monitor = null;
        }
        this._icon.disconnect(this._repaintId);
        this._repaintId = 0;
        this._icon = null;
        this._label = null;
        this._settings = null;
        this._lastKnown = {};
        this._lowNotified = {};
        super.destroy();
    }

});

export default class RazerBatteryExtension extends Extension {
    enable() {
        this._indicator = new BatteryIndicator(this.getSettings(), this.uuid);
        Main.panel.addToStatusArea('battery-razer', this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}