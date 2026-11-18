import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

const INPUT_IDLE_MS = 5000;
const ACTIVITY_COALESCE_US = 5 * 1000 * 1000;

export class ActivityWatch {
    constructor(backend, onActivity) {
        this._backend = backend;
        this._onActivity = onActivity;
        this._lastActivity = null;
        this._monitor = backend.get_core_idle_monitor();
        this._activeId = 0;
        // Observe input inactivity even while video playback inhibits screen blanking.
        this._idleId = this._monitor.add_idle_watch_full(INPUT_IDLE_MS,
            Meta.IdleMonitorWatchFlags.UNINHIBITABLE, () => this._armActive());
        this._deviceId = backend.connect('last-device-changed', (source, device) => {
            if (device && device.get_vendor_id() === 0x1532 &&
                device.get_device_type() === Clutter.InputDeviceType.POINTER_DEVICE)
                this._emitActivity();
        });
        if (this._monitor.get_idletime() >= INPUT_IDLE_MS)
            this._armActive();
    }

    _armActive() {
        if (this._activeId)
            return;
        this._activeId = this._monitor.add_user_active_watch(() => {
            this._activeId = 0;
            this._emitActivity();
        });
    }

    _emitActivity() {
        const now = GLib.get_monotonic_time();
        if (this._lastActivity !== null && now - this._lastActivity < ACTIVITY_COALESCE_US)
            return;
        this._lastActivity = now;
        this._onActivity();
    }

    destroy() {
        if (this._activeId) {
            this._monitor.remove_watch(this._activeId);
            this._activeId = 0;
        }
        this._monitor.remove_watch(this._idleId);
        this._idleId = 0;
        this._backend.disconnect(this._deviceId);
        this._deviceId = 0;
        this._monitor = null;
        this._backend = null;
        this._onActivity = null;
    }
}
