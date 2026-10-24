// Async, non-blocking sysfs reads for the battery state. Every file read
// goes through load_contents_async, so the razermouse driver's ~1 s HID
// timeout on a sleeping mouse runs in a GIO worker thread and never blocks
// the gnome-shell main loop.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {SCAN_DIR} from './constants.js';

const DECODER = new TextDecoder();

/**
 * Collect the battery state of every Razer device the kernel driver
 * exposes (sysfs ids look like 0003:1532:00D7.0004 — the part before the
 * last dot identifies the physical device).
 *
 * Per device: charge_level of each interface, best nonzero reading wins
 * (idle interfaces return raw 0 = no data). charge_status is read only
 * for devices with a nonzero level — a sleeping device reads 0 and its
 * charging state is meaningless, so skipping it halves the kernel traffic
 * during sleep.
 *
 * @param {(devices: Record<string, {level: number, charging: boolean}>) => void} callback
 *   invoked once, in the main loop, with raw levels (0-255)
 */
export function readBatteriesAsync(callback) {
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
export function listInterfaces(callback) {
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
                    try {
                        enumerator.close(null);
                    } catch (e) {}
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
export function readBest(interfaceIds, callback) {
    let best = 0;
    let pending = interfaceIds.length;
    if (pending === 0) {
        callback(best);
        return;
    }
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
export function readCharging(interfaceIds, callback) {
    let pending = interfaceIds.length;
    let fired = false;
    const done = value => {
        if (!fired) {
            fired = true;
            callback(value === 1);
        }
    };
    if (pending === 0) {
        done(0);
        return;
    }
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
export function readIntAsync(path, callback) {
    Gio.File.new_for_path(path).load_contents_async(null, (src, res) => {
        try {
            const [, bytes] = src.load_contents_finish(res);
            callback(parseInt(DECODER.decode(bytes), 10));
        } catch (e) {
            callback(null);
        }
    });
}