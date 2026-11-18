import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';
import {BatteryReader, readIntAsync} from '../battery-razer@bl3xand.dev/battery.js';

function assert(value, message) {
    if (!value)
        throw new Error(message);
}
const loop = new GLib.MainLoop(null, false);
let exitCode = 0;
async function main() {
    const reader = new BatteryReader(ARGV[0]);
    const first = reader.read();
    assert(first === reader.read(), 'Concurrent calls did not share one scan');
    const devices = await first;
    assert(devices['0003:1532:00D7'].level === 204, 'Duplicate fallback failed');
    assert(devices['0003:1532:00D7'].charging, 'Charging was not read');
    assert(devices['0003:1532:00D6'].level === 0, 'Sleeping transport disappeared');
    assert(Object.keys(devices).length === 2, 'Non-Razer entries were accepted');
    const again = await reader.read();
    assert(again['0003:1532:00D7'].level === 204, 'Preferred interface failed');
    const cancellable = new Gio.Cancellable();
    assert(await readIntAsync(`${ARGV[0]}/invalid`, cancellable) === null, 'Malformed value accepted');
    assert(await readIntAsync(`${ARGV[0]}/out-of-range`, cancellable) === null, 'Out-of-range value accepted');
    const stopped = new BatteryReader(ARGV[0]);
    const pending = stopped.read();
    stopped.destroy();
    let canceled = false;
    try {
        await pending;
    } catch (error) {
        canceled = error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
    }
    assert(canceled, 'Canceled scan completed successfully');
    assert(await stopped.read() === null, 'Stopped reader restarted');
    reader.destroy();
    const absent = new BatteryReader(`${ARGV[0]}/missing-directory`);
    let missing = false;
    try {
        await absent.read();
    } catch (error) {
        missing = error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
    }
    absent.destroy();
    assert(missing, 'Missing driver was confused with an empty device list');
    print('Native GJS/GIO smoke passed');
}
main().catch(error => {
    logError(error);
    exitCode = 1;
}).finally(() => loop.quit());
loop.run();
System.exit(exitCode);
