import Gio from 'gi://Gio';
import {DRIVER_SETUP_URL} from './constants.js';

export async function launchInstaller(cancellable) {
    await new Promise((resolve, reject) => {
        Gio.AppInfo.launch_default_for_uri_async(DRIVER_SETUP_URL, null,
            cancellable, (source, result) => {
                try {
                    Gio.AppInfo.launch_default_for_uri_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
    });
    return false;
}
