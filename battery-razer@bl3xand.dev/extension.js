import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {POLL_SEC, HOTPLUG_DEBOUNCE_SEC, ICON_PX, DEBUG, SCAN_DIR, BOLT,
    DRIVER_SETUP_URL, DRIVER_SETUP_RAW} from './constants.js';
import {paintMouse, panelTextIsDark} from './mouseIcon.js';

const DECODER = new TextDecoder();

/** Debug log, greppable in the journal as "battery-razer". */
function debug(...args) {
    if (DEBUG)
        console.log(`battery-razer: ${args.join(' ')}`);
}

/**
 * Collect the battery state of every Razer device the kernel driver
 * exposes (sysfs ids look like 0003:1532:00D7.0004 — the part before the
 * last dot identifies the physical device). Fully async: every file read
 * goes through load_contents_async, so the razermouse driver's ~1 s HID
 * timeout on a sleeping mouse runs in a GIO worker thread and never
 * blocks the gnome-shell main loop.
 *
 * Per device: charge_level of each interface, best nonzero reading wins
 * (idle interfaces return raw 0 = no data). charge_status is read only
 * for devices with a nonzero level — a sleeping device reads 0 and its
 * charging state is meaningless, so skipping it halves the kernel
 * traffic (and the journal timeout spam) during sleep.
 *
 * @param {(devices: Record<string, {level: number, charging: boolean}>) => void} callback
 *   invoked once, in the main loop, with raw levels (0-255)
 */
function readBatteriesAsync(callback) {
    listInterfaces(ids => {
        const byPid = {};
        for (const id of ids) {
            const pid = id.substring(0, id.lastIndexOf('.'));
            (byPid[pid] ??= []).push(id);
        }
        const pids = Object.keys(byPid);
        const devices = {};
        let pending = pids.length;
        if (pending === 0) {
            callback(devices);
            return;
        }
        // Phase 1: charge_level per device (best nonzero across interfaces).
        for (const pid of pids) {
            readBest(byPid[pid], level => {
                devices[pid] = {level, charging: false};
                if (--pending > 0)
                    return;
                // Phase 2: charge_status only for live devices.
                const live = pids.filter(p => devices[p].level > 0);
                let waiting = live.length;
                if (waiting === 0) {
                    callback(devices);
                    return;
                }
                for (const pid2 of live) {
                    readCharging(byPid[pid2], charging => {
                        devices[pid2].charging = charging;
                        if (--waiting === 0)
                            callback(devices);
                    });
                }
            });
        }
    });
}

/** Enumerate 0003:* interface ids in the driver directory, async. */
function listInterfaces(callback) {
    const dir = Gio.File.new_for_path(SCAN_DIR);
    dir.enumerate_children_async('standard::*',
        Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (src, res) => {
            let enumerator;
            try {
                enumerator = src.enumerate_children_finish(res);
            } catch (e) {
                callback([]); // driver not loaded — no Razer devices
                return;
            }
            const ids = [];
            const next = (src2, res2) => {
                let infos;
                try {
                    infos = src2.next_files_finish(res2);
                } catch (e) {
                    infos = [];
                }
                if (infos.length === 0) {
                    enumerator.close(null);
                    callback(ids);
                    return;
                }
                for (const info of infos) {
                    const name = info.get_name();
                    if (name.startsWith('0003:'))
                        ids.push(name);
                }
                enumerator.next_files_async(16, GLib.PRIORITY_DEFAULT, null, next);
            };
            enumerator.next_files_async(16, GLib.PRIORITY_DEFAULT, null, next);
        });
}

/**
 * Read charge_level from every interface of a device, keep the best
 * nonzero reading. Async, non-blocking.
 */
function readBest(interfaceIds, callback) {
    let best = 0;
    let pending = interfaceIds.length;
    for (const id of interfaceIds) {
        readIntAsync(`${SCAN_DIR}/${id}/charge_level`, value => {
            if (value !== null && value > best)
                best = value;
            if (--pending === 0)
                callback(best);
        });
    }
}

/**
 * Whether a live device is charging: any interface reporting
 * charge_status 1 counts. Single-shot callback.
 */
function readCharging(interfaceIds, callback) {
    let pending = interfaceIds.length;
    let fired = false;
    const done = value => {
        if (!fired) {
            fired = true;
            callback(value === 1);
        }
    };
    for (const id of interfaceIds) {
        readIntAsync(`${SCAN_DIR}/${id}/charge_status`, value => {
            if (value === 1)
                done(1);
            else if (--pending === 0)
                done(0);
        });
    }
}

/** Async read a whole sysfs file, parse as integer, null on any failure. */
function readIntAsync(path, callback) {
    Gio.File.new_for_path(path).load_contents_async(null, (src, res) => {
        try {
            const [, bytes] = src.load_contents_finish(res);
            callback(parseInt(DECODER.decode(bytes), 10));
        } catch (e) {
            callback(null);
        }
    });
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
        this._lowNotified = {};
        this._lastKnown = {};
        this._driverMissing = false;
        this._installRequested = false;
        this._reading = false;
        this._timeoutId = null;
        this._debounceId = null;
        this._monitorId = null;
        this._destroyed = false;

        // Startup: check the kernel driver ONCE. If missing, go dormant
        // ('!' state, zero polling) and watch for the driver dir to appear.
        // If present, start the flat poll and watch for hotplug.
        this._monitor = null;
        this._driverWatchId = null;
        if (Gio.File.new_for_path(SCAN_DIR).query_exists(null)) {
            this._driverMissing = false;
            this._startPolling();
        } else {
            this._driverMissing = true;
            this._label.text = '!';
            this._rebuildMenu({}, []);
            this._watchForDriver();
        }
    }

    _startPolling() {
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
            const drivers = Gio.File.new_for_path('/sys/bus/hid/drivers');
            const watch = drivers.monitor_directory(
                Gio.FileMonitorFlags.NONE, null);
            this._driverWatchId = watch.connect('changed', (mon, file, other, evtype) => {
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

    /** Log out of the GNOME session (systemd-logind, no confirmation). */
    _logout() {
        try {
            Gio.Subprocess.new(['gnome-session-quit', '--logout', '--no-prompt'],
                Gio.SubprocessFlags.NONE);
        } catch (e) {
            // Fallback: logind D-Bus call.
            Gio.DBus.system.call(
                'org.freedesktop.login1',
                '/org/freedesktop/login1/session/auto',
                'org.freedesktop.login1.Session',
                'Terminate', null, null, Gio.DBusCallFlags.NONE, -1, null, null);
        }
    }

    /**
     * Open the user's default terminal running the one-command installer
     * (curl | bash). sudo is requested by the script inside the terminal,
     * so the user types their password there — nothing privileged ever
     * runs inside gnome-shell.
     */
    _launchInstaller() {
        const cmd = `curl -fsSL ${DRIVER_SETUP_RAW} | bash`;
        let terminal = null;
        try {
            terminal = new Gio.Settings({schema_id:
                'org.gnome.desktop.default-applications.terminal'})
                .get_string('exec');
        } catch (e) {}
        const candidates = [
            terminal,
            'x-terminal-emulator', // Debian/Ubuntu default-apps indirection
            'gnome-terminal', 'kgx', 'konsole', 'xfce4-terminal',
            'mate-terminal', 'xterm',
        ].filter(t => t);
        for (const term of candidates) {
            let argv = null;
            if (term === 'xdg-terminal-exec')
                argv = [term, 'bash', '-c', cmd];
            else if (term === 'gnome-terminal' || term === 'kgx')
                argv = [term, '--', 'bash', '-c', cmd];
            else if (term === 'konsole')
                argv = [term, '-e', 'bash', '-c', cmd];
            else if (term === 'xfce4-terminal' || term === 'mate-terminal')
                argv = [term, '-x', 'bash', '-c', cmd];
            else
                argv = [term, '-e', 'bash', '-c', cmd];
            try {
                Gio.Subprocess.new(argv,
                    Gio.SubprocessFlags.NONE);
                return;
            } catch (e) {
                debug(`terminal ${term} failed: ${e.message}`);
            }
        }
        // No terminal found: open the instructions in a browser instead.
        Gio.AppInfo.launch_default_for_uri(DRIVER_SETUP_URL, null);
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
                this.menu.addAction(_('Log out and back in'), () =>
                    this._logout());
            } else {
                this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                    _('OpenRazer driver not installed'), {reactive: false}));
                this.menu.addAction(_('Install driver'), () => {
                    this._installRequested = true;
                    this._launchInstaller();
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
        this.menu.addAction(_('Quit'), () => this.destroy());
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
        this._indicator = new BatteryIndicator(this.getSettings());
        Main.panel.addToStatusArea('battery-razer', this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}