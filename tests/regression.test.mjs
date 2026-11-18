import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../battery-razer@bl3xand.dev/', import.meta.url));
const flush = () => new Promise(resolve => setImmediate(resolve));
class IOError extends Error {
    constructor(domain, code, message) { super(message); this.code = code; }
    matches(domain, code) { return this.code === code; }
}
class Cancellable {
    canceled = false;
    cancel() { this.canceled = true; }
    is_cancelled() { return this.canceled; }
}
async function load(file, mocks) {
    const context = vm.createContext({TextDecoder, console, global: mocks.__global ?? {}});
    const cache = new Map();
    async function moduleFor(name) {
        if (cache.has(name)) return cache.get(name);
        let mod;
        if (Object.hasOwn(mocks, name)) {
            const exports = mocks[name];
            mod = new vm.SyntheticModule(Object.keys(exports), function () {
                for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
            }, {context, identifier: name});
        } else {
            mod = new vm.SourceTextModule(await readFile(name, 'utf8'), {context, identifier: name});
        }
        cache.set(name, mod);
        return mod;
    }
    const entry = await moduleFor(file);
    await entry.link((name, parent) => moduleFor(name.startsWith('.') ? path.resolve(path.dirname(parent.identifier), name) : name));
    await entry.evaluate();
    return entry.namespace;
}
function ioEnvironment(values) {
    let active = 0, peak = 0, closed = 0;
    const reads = [], held = [];
    const ids = [...new Set(Object.keys(values).map(x => x.split('/')[0]))];
    const Gio = {Cancellable, IOErrorEnum: {CANCELLED: 1, NOT_FOUND: 2}, io_error_quark: () => 1,
        FileQueryInfoFlags: {NOFOLLOW_SYMLINKS: 1, NONE: 0}, File: {new_for_path(file) {
            const key = file.split('/').slice(-2).join('/');
            const source = {
                load_contents_async(cancel, callback) {
                    reads.push(key); peak = Math.max(peak, ++active);
                    const complete = () => { --active; callback(source, {cancel}); };
                    if (values[key] === 'hold') held.push(complete); else queueMicrotask(complete);
                },
                load_contents_finish({cancel}) {
                    if (cancel?.is_cancelled()) throw new IOError(1, 1, 'cancelled');
                    if (!Object.hasOwn(values, key)) throw new IOError(1, 2, 'not found');
                    return [true, new TextEncoder().encode(String(values[key]))];
                },
                enumerate_children_async(attributes, flags, priority, cancel, callback) {
                    queueMicrotask(() => callback(source, {cancel}));
                },
                enumerate_children_finish({cancel}) {
                    if (cancel.is_cancelled()) throw new IOError(1, 1, 'cancelled');
                    let delivered = false;
                    const e = {
                        next_files_async(size, priority, cancel, cb) { queueMicrotask(() => cb(e, {cancel})); },
                        next_files_finish({cancel}) {
                            if (cancel.is_cancelled()) throw new IOError(1, 1, 'cancelled');
                            if (delivered) return [];
                            delivered = true; return ids.map(id => ({get_name: () => id}));
                        },
                        close_async(priority, cancel, cb) { ++closed; queueMicrotask(() => cb(e, {})); },
                        close_finish() { return true; },
                        close() { ++closed; },
                    };
                    return e;
                },
            };
            return source;
        }}};
    return {Gio, reads, held, stats: () => ({active, peak, closed}),
        mocks: {'gi://Gio': {default: Gio}, 'gi://GLib': {default: {PRIORITY_DEFAULT: 0, Error: IOError}}}};
}

test('one scan, serial reads, duplicate interfaces skipped after a valid response', async () => {
    const io = ioEnvironment({'0003:1532:00D7.0001/charge_level': 204,
        '0003:1532:00D7.0001/charge_status': 1, '0003:1532:00D7.0002/charge_level': 255,
        '0003:1532:00D7.0002/charge_status': 'hold'});
    const {BatteryReader} = await load(path.join(root, 'battery.js'), io.mocks);
    const reader = new BatteryReader();
    const result = reader.read(); assert.equal(result, reader.read());
    const state = await result;
    assert.equal(state['0003:1532:00D7'].level, 204);
    assert.equal(state['0003:1532:00D7'].charging, true);
    assert.equal(io.stats().peak, 1); assert.equal(io.stats().active, 0);
    assert.equal(io.reads.length, 2); assert.equal(io.stats().closed, 1);
    reader.destroy();
});
test('cancellation of a held read never starts charging or the next interface', async () => {
    const io = ioEnvironment({'0003:1532:00D7.0001/charge_level': 'hold',
        '0003:1532:00D7.0001/charge_status': 1, '0003:1532:00D7.0002/charge_level': 255});
    const {BatteryReader} = await load(path.join(root, 'battery.js'), io.mocks);
    const reader = new BatteryReader(); const pending = reader.read();
    await flush(); assert.equal(io.held.length, 1);
    const rejected = assert.rejects(pending, /cancelled/);
    reader.destroy(); io.held[0](); await rejected;
    assert.equal(io.reads.length, 1); assert.equal(io.stats().active, 0);
    assert.equal(await reader.read(), null);
});
test('bad values cannot become a battery or a false charge state', async () => {
    const io = ioEnvironment({'0003:1532:00D7.0001/charge_level': '255garbage',
        '0003:1532:00D7.0002/charge_level': 300, '0003:1532:00D7.0003/charge_level': 0});
    const {BatteryReader} = await load(path.join(root, 'battery.js'), io.mocks);
    const reader = new BatteryReader(); const state = await reader.read();
    assert.equal(state['0003:1532:00D7'].level, 0);
    assert.equal(io.reads.some(x => x.endsWith('/charge_status')), false);
    reader.destroy();
});
test('baseline demonstrates premature completion with an outstanding HID read', {skip: !process.env.RAZER_BASELINE}, async () => {
    const io = ioEnvironment({'0003:1532:00D7.0001/charge_status': 1,
        '0003:1532:00D7.0002/charge_status': 'hold'});
    const baseline = await load(process.env.RAZER_BASELINE, io.mocks);
    let pendingAtCompletion;
    baseline.readCharging(['0003:1532:00D7.0001', '0003:1532:00D7.0002'], () => {
        pendingAtCompletion = io.stats().active;
    });
    await flush();
    assert.equal(pendingAtCompletion, 1);
    assert.equal(io.stats().peak, 2);
    io.held[0]();
});

function uiEnvironment() {
    let nextId = 1;
    const timers = new Map(), monitors = [], readers = [], activities = [];
    class Actor {
        constructor(props = {}) { Object.assign(this, props); this.signals = new Map(); }
        connect(name, cb) { const id = nextId++; this.signals.set(id, cb); return id; }
        disconnect(id) { assert(this.signals.delete(id), 'disconnect of an unknown signal'); }
        add_child() {}
        cancel() { this.canceled = true; }
    }
    class Button extends Actor {
        constructor(...args) { super(); this._init(...args); }
        _init() {
            this.menu = {items: [], removeAll() {this.items = [];}, addMenuItem(i) {this.items.push(i);},
                addAction(text, cb) {this.items.push({text, cb});}};
        }
        destroy() { this.destroyed = true; }
    }
    class Reader {
        constructor() { this.requests = []; readers.push(this); }
        read() { return new Promise((resolve, reject) => this.requests.push({resolve, reject})); }
        destroy() { this.stopped = true; }
    }
    class Activity {
        constructor(backend, callback) { this.callback = callback; activities.push(this); }
        destroy() { this.stopped = true; }
    }
    const Gio = {Cancellable, FileMonitorFlags: {NONE: 0}, IOErrorEnum: {NOT_FOUND: 2}, File: {new_for_path() {
        return {monitor_directory() {const m = new Actor(); monitors.push(m); return m;}};
    }}};
    const GLib = {Error: IOError, PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
        timeout_add_seconds(priority, seconds, callback) {const id = nextId++; timers.set(id, {seconds, callback}); return id;},
        Source: {remove(id) { assert(timers.delete(id), 'removal of a stale source ID'); }}};
    const panel = {addToStatusArea(name, indicator) { panel.indicator = indicator; }};
    const main = {panel, notify() {}, notifyError() {}, extensionManager: {disableExtension() {}}};
    class Extension { getSettings() {return {get_int: () => 20};} }
    return {timers, monitors, readers, activities, panel, fire(id) {const t = timers.get(id); timers.delete(id); t.callback();},
        mocks: {'gi://St': {default: {Label: Actor, BoxLayout: Actor, DrawingArea: Actor}},
            'gi://GLib': {default: GLib}, 'gi://Gio': {default: Gio},
            'gi://GObject': {default: {registerClass: cls => cls}},
            'gi://Clutter': {default: {ActorAlign: {CENTER: 0}}},
            'resource:///org/gnome/shell/ui/main.js': main,
            'resource:///org/gnome/shell/ui/panelMenu.js': {Button},
            'resource:///org/gnome/shell/ui/popupMenu.js': {PopupMenuItem: Actor, PopupSeparatorMenuItem: Actor},
            'resource:///org/gnome/shell/extensions/extension.js': {Extension, gettext: s => s},
            [path.join(root, 'battery.js')]: {BatteryReader: Reader},
            [path.join(root, 'activity.js')]: {ActivityWatch: Activity},
            [path.join(root, 'mouseIcon.js')]: {paintMouse() {}},
            [path.join(root, 'actions.js')]: {launchInstaller: async () => false}}};
}
const awake = () => ({'0003:1532:00D7': {level: 204, charging: false}});
test('disable during a scan and re-enable cannot update a destroyed indicator', async () => {
    const ui = uiEnvironment(); const {default: Extension} = await load(path.join(root, 'extension.js'), ui.mocks);
    const extension = new Extension(); extension.enable(); const old = ui.panel.indicator;
    extension.disable(); extension.enable(); const current = ui.panel.indicator;
    ui.readers[0].requests[0].resolve(awake()); await flush();
    assert(old.destroyed); assert.equal(current._label.text, '…'); assert.equal(ui.timers.size, 0);
    ui.readers[1].requests[0].resolve(awake()); await flush();
    assert.equal(current._label.text, '80%');
    assert.equal([...ui.timers.values()][0].seconds, 30);
    extension.disable(); assert.equal(ui.timers.size, 0);
    for (const monitor of ui.monitors) {assert(monitor.canceled); assert.equal(monitor.signals.size, 0);}
});
test('hotplug bursts coalesce and a queued refresh waits for the active scan', async () => {
    const ui = uiEnvironment(); const {default: Extension} = await load(path.join(root, 'extension.js'), ui.mocks);
    const extension = new Extension(); extension.enable(); const indicator = ui.panel.indicator;
    for (let n = 0; n < 20; n++) indicator._scheduleHotRefresh();
    assert.equal(ui.timers.size, 1); ui.fire(indicator._debounceId);
    assert.equal(ui.readers[0].requests.length, 1);
    ui.readers[0].requests[0].resolve(awake()); await flush();
    assert.equal(ui.readers[0].requests.length, 2); assert.equal(ui.timers.size, 0);
    ui.readers[0].requests[1].resolve(awake()); await flush();
    assert.equal(ui.timers.size, 1); extension.disable(); assert.equal(ui.timers.size, 0);
});
test('driver absent is dormant with a monitor and no periodic sources', async () => {
    const ui = uiEnvironment(); const {default: Extension} = await load(path.join(root, 'extension.js'), ui.mocks);
    const extension = new Extension(); extension.enable();
    ui.readers[0].requests[0].reject(new IOError(1, 2, 'driver absent')); await flush();
    assert.equal(ui.panel.indicator._label.text, '!'); assert.equal(ui.timers.size, 0);
    extension.disable();
});
test('fifty enable/disable cycles release all timers, monitors and reader ownership', async () => {
    const ui = uiEnvironment(); const {default: Extension} = await load(path.join(root, 'extension.js'), ui.mocks);
    const extension = new Extension();
    for (let n = 0; n < 50; n++) {
        extension.enable(); ui.readers[n].requests[0].resolve(awake()); await flush(); extension.disable();
        assert.equal(ui.timers.size, 0);
    }
    assert(ui.readers.every(r => r.stopped));
    assert(ui.monitors.every(m => m.canceled && m.signals.size === 0));
});

test('input resumption replaces the slow fallback with an immediate scan', async () => {
    const ui = uiEnvironment(); const {default: Extension} = await load(path.join(root, 'extension.js'), ui.mocks);
    const extension = new Extension(); extension.enable();
    ui.readers[0].requests[0].resolve(awake()); await flush();
    ui.panel.indicator._refresh();
    ui.readers[0].requests[1].resolve({'0003:1532:00D7': {level: 0, charging: false}}); await flush();
    assert.equal(ui.panel.indicator._label.text, '80%');
    assert.equal([...ui.timers.values()][0].seconds, 120);
    ui.activities[0].callback();
    assert.equal(ui.readers[0].requests.length, 3);
    assert.equal(ui.timers.size, 0);
    extension.disable();
    ui.readers[0].requests[2].resolve(awake()); await flush();
    assert(ui.activities[0].stopped); assert.equal(ui.timers.size, 0);
});
test('native activity watches coalesce bursts, filter devices and release one-shot ownership', async () => {
    let next = 1, now = 0, calls = 0, handler;
    const watches = new Map();
    const monitor = {
        get_idletime: () => 6000,
        add_idle_watch_full(ms, flags, cb) {assert.equal(ms, 5000); assert.equal(flags, 1); const id = next++; watches.set(id, {cb, once: false}); return id;},
        add_user_active_watch(cb) {const id = next++; watches.set(id, {cb, once: true}); return id;},
        remove_watch(id) {assert(watches.delete(id));},
    };
    const backend = {get_core_idle_monitor: () => monitor,
        connect(name, cb) {assert.equal(name, 'last-device-changed'); handler = cb; return 77;},
        disconnect(id) {assert.equal(id, 77); handler = null;}};
    const mocks = {'gi://GLib': {default: {get_monotonic_time: () => now}},
        'gi://Clutter': {default: {InputDeviceType: {POINTER_DEVICE: 1}}},
        'gi://Meta': {default: {IdleMonitorWatchFlags: {UNINHIBITABLE: 1}}}};
    const {ActivityWatch} = await load(path.join(root, 'activity.js'), mocks);
    const activity = new ActivityWatch(backend, () => ++calls);
    const fire = id => {const w = watches.get(id); if (w.once) watches.delete(id); w.cb();};
    fire(activity._activeId); assert.equal(calls, 1); assert.equal(activity._activeId, 0);
    const mouse = {get_vendor_id: () => 0x1532, get_device_type: () => 1};
    for (let n = 0; n < 100; n++) handler(backend, mouse);
    assert.equal(calls, 1);
    now = 6e6;
    handler(backend, {get_vendor_id: () => 1, get_device_type: () => 1}); assert.equal(calls, 1);
    handler(backend, mouse); assert.equal(calls, 2);
    fire(activity._idleId); assert(activity._activeId);
    activity.destroy(); assert.equal(watches.size, 0); assert.equal(handler, null);
});
