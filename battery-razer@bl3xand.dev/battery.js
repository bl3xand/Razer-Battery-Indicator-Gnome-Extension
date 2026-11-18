import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {SCAN_DIR} from './constants.js';

const DECODER = new TextDecoder();

function checkCancellation(cancellable) {
    if (cancellable.is_cancelled())
        throw new GLib.Error(Gio.io_error_quark(),
            Gio.IOErrorEnum.CANCELLED, 'Battery read cancelled');
}

export function readIntAsync(path, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).load_contents_async(cancellable, (file, result) => {
            let bytes;
            try {
                [, bytes] = file.load_contents_finish(result);
            } catch (error) {
                if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    reject(error);
                else
                    resolve(null);
                return;
            }
            const text = DECODER.decode(bytes).trim();
            const value = /^\d+$/.test(text) ? Number(text) : NaN;
            resolve(Number.isInteger(value) && value >= 0 && value <= 255 ? value : null);
        });
    });
}

export async function listInterfaces(directory, cancellable) {
    const enumerator = await new Promise((resolve, reject) => {
        Gio.File.new_for_path(directory).enumerate_children_async(
            'standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT, cancellable, (file, result) => {
                try {
                    resolve(file.enumerate_children_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
    });
    const ids = [];
    try {
        while (true) {
            checkCancellation(cancellable);
            const infos = await new Promise((resolve, reject) => {
                enumerator.next_files_async(16, GLib.PRIORITY_DEFAULT,
                    cancellable, (source, result) => {
                        try {
                            resolve(source.next_files_finish(result));
                        } catch (error) {
                            reject(error);
                        }
                    });
            });
            if (infos.length === 0)
                return ids.sort();
            for (const info of infos) {
                const name = info.get_name();
                if (/^0003:1532:[0-9A-Fa-f]{4}\.[0-9A-Fa-f]+$/.test(name))
                    ids.push(name);
            }
        }
    } finally {
        // Cleanup must still close the directory after cancellation.
        await new Promise((resolve, reject) => {
            enumerator.close_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
                try {
                    source.close_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        });
    }
}

export class BatteryReader {
    constructor(directory = SCAN_DIR) {
        this._directory = directory;
        this._cancellable = new Gio.Cancellable();
        this._preferred = new Map();
        this._pending = null;
    }

    read() {
        if (!this._cancellable)
            return Promise.resolve(null);
        if (!this._pending) {
            this._pending = this._collect(this._cancellable).finally(() => {
                this._pending = null;
            });
        }
        return this._pending;
    }

    async _collect(cancellable) {
        const groups = new Map();
        for (const id of await listInterfaces(this._directory, cancellable)) {
            const pid = id.substring(0, id.lastIndexOf('.'));
            if (!groups.has(pid))
                groups.set(pid, []);
            groups.get(pid).push(id);
        }
        const devices = {};
        for (const pid of this._preferred.keys()) {
            if (!groups.has(pid))
                this._preferred.delete(pid);
        }
        // The interfaces share one USB device. Never queue concurrent HID reads.
        for (const [pid, ids] of groups) {
            const preferred = this._preferred.get(pid);
            ids.sort((a, b) => Number(b === preferred) - Number(a === preferred));
            devices[pid] = {level: 0, charging: false};
            for (const id of ids) {
                checkCancellation(cancellable);
                const base = `${this._directory}/${id}`;
                const level = await readIntAsync(`${base}/charge_level`, cancellable);
                checkCancellation(cancellable);
                if (level === null || level === 0)
                    continue;
                const status = await readIntAsync(`${base}/charge_status`, cancellable);
                checkCancellation(cancellable);
                devices[pid] = {level, charging: status === 1};
                this._preferred.set(pid, id);
                break;
            }
        }
        checkCancellation(cancellable);
        return devices;
    }

    destroy() {
        this._cancellable.cancel();
        this._cancellable = null;
        this._preferred.clear();
    }
}
