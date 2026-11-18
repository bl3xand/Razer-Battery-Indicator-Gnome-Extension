import Gio from 'gi://Gio';
import {DRIVER_SETUP_RAW, DRIVER_SETUP_URL} from './constants.js';
import {debug} from './log.js';

/**
 * Open the user's default terminal running the one-command installer
 * (curl | bash). The terminal is picked in order: the gsettings default,
 * then distro conventions (x-terminal-emulator, xdg-terminal-exec), then
 * well-known names — each with its own command-passing syntax.
 */
export async function launchInstaller(cancellable) {
    const cmd = `curl -fsSL ${DRIVER_SETUP_RAW} | bash`;
    let terminal = null;
    try {
        const schema = Gio.SettingsSchemaSource.get_default()
            .lookup('org.gnome.desktop.default-applications.terminal', true);
        if (schema)
            terminal = new Gio.Settings({settings_schema: schema}).get_string('exec');
    } catch (e) {}
    const candidates = [
        terminal,
        'xdg-terminal-exec', // freedesktop standard default
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
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
            return true;
        } catch (e) {
            debug(`terminal ${term} failed: ${e.message}`);
        }
    }
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
