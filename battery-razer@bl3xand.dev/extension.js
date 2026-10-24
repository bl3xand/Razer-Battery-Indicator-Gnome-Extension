import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {POLL_SEC, HOTPLUG_DEBOUNCE_SEC, ICON_PX, SCAN_DIR, BOLT}
    from './constants.js';
import {paintMouse, panelTextIsDark} from './mouseIcon.js';
import {readBatteriesAsync} from './battery.js';
import {launchInstaller, reboot} from './actions.js';
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
        // Icon: the mouse silhouette drawn from a potrace path embedded in
        // mouseIcon.js (no image files). Cairo fills it with the color
        // contrasting the panel color-scheme.
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
        icon.connect('repaint', (area) => this._paintIcon(area));
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
        this._timeoutId = null;
        this._debounceId = null;
        this._monitorId = null;
        this._monitor = null;
        this._driverWatch = null;
        this._driverWatchId = null;
        this._slowWakeId = null;
        this._destroyed = false;
        this._menuKey = null;

        // Startup: check the kernel driver ONCE. If missing, go dormant
        // ('!' state, zero polling) and watch for the driver dir to appear.
        // If present, start the flat poll and watch for hotplug.
        if (Gio.File.new_for_path(SCAN_DIR).query_exists(null)) {
            this._startPolling();
        } else {
            this._driverMissing = true;
            this._label.text = '!';
            this._rebuildMenu({}, []);
            this._watchForDriver();
        }
    }

    _startPolling() {
        // Delivered-after-destroy watch events and double deliveries must
        // neither start timers on a dead indicator nor stack a second poll.
        if (this._destroyed || this._timeoutId !== null)
            return;
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
        try {
            this._monitor = Gio.File.new_for_path(SCAN_DIR).monitor_directory(
                Gio.FileMonitorFlags.NONE, null);
            this._monitorId = this._monitor.connect('changed',
                () => { debug('hotplug event'); this._scheduleHotRefresh(); });
        } catch (e) {
            this._monitor = null; // sysfs watches unsupported — poll only
        }
    }

    /** Dormant mode: wake up as soon as the driver directory appears. */
    _watchForDriver() {
        try {
            const watch = Gio.File.new_for_path('/sys/bus/hid/drivers')
                .monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._driverWatchId = watch.connect('changed',
                (mon, file, other, evtype) => {
                    if (file && file.get_basename() === 'razermouse' &&
                        Gio.File.new_for_path(SCAN_DIR).query_exists(null)) {
                        debug('driver appeared, waking up');
                        this._driverMissing = false;
                        if (this._driverWatchId) {
                            watch.disconnect(this._driverWatchId);
                            this._driverWatchId = null;
                        }
                        watch.cancel();
                        this._startPolling();
                    }
                });
            this._driverWatch = watch;
        } catch (e) {
            // Watch unsupported: fall back to a slow existence check.
            this._driverWatchId = null;
            this._slowWakeId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, 30, () => {
                    if (Gio.File.new_for_path(SCAN_DIR).query_exists(null)) {
                        this._driverMissing = false;
                        this._startPolling();
                        return GLib.SOURCE_REMOVE;
                    }
                    return GLib.SOURCE_CONTINUE;
                });
        }
    }

    /** Draw the mouse silhouette (see mouseIcon.js). */
    _paintIcon(area) {
        const cr = area.get_context();
        paintMouse(cr, area.width, panelTextIsDark());
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

    /** One poll cycle. Async: applies the state once reads complete. */
    _refresh() {
        if (this._destroyed || this._reading)
            return;
        this._reading = true;
        readBatteriesAsync(devices => {
            this._reading = false;
            if (this._destroyed)
                return;
            this._apply(devices);
        });
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
                    _('Driver installed'), {reactive: false}));
                this.menu.addAction(_('Reboot'), () => reboot());
            } else {
                this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                    _('OpenRazer driver not installed'), {reactive: false}));
                this.menu.addAction(_('Install driver'), () => {
                    this._installRequested = true;
                    launchInstaller();
                    this._menuKey = 'installed';
                    this._rebuildMenu({}, []);
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

    vfunc_destroy() {
        this._destroyed = true;
        this._removeTimeout('_timeoutId');
        this._removeTimeout('_debounceId');
        this._removeTimeout('_slowWakeId');
        if (this._driverWatch) {
            if (this._driverWatchId)
                this._driverWatch.disconnect(this._driverWatchId);
            this._driverWatch.cancel();
            this._driverWatch = null;
        }
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