// External-process helpers: launching the driver installer in the user's
// default terminal and rebooting via the session manager. Nothing
// privileged ever runs inside gnome-shell — sudo is typed by the user in
// the terminal the installer opens.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {DRIVER_SETUP_RAW, DRIVER_SETUP_URL} from './constants.js';
import {debug} from './log.js';

/**
 * Open the user's default terminal running the one-command installer
 * (curl | bash). The terminal is picked in order: the gsettings default,
 * then distro conventions (x-terminal-emulator, xdg-terminal-exec), then
 * well-known names — each with its own command-passing syntax.
 */
export function launchInstaller() {
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
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
            return;
        } catch (e) {
            debug(`terminal ${term} failed: ${e.message}`);
        }
    }
    // No terminal found: open the instructions in a browser instead.
    Gio.AppInfo.launch_default_for_uri(DRIVER_SETUP_URL, null);
}

/** Reboot the machine (session manager, no confirmation dialog). */
export function reboot() {
    try {
        Gio.Subprocess.new(['gnome-session-quit', '--reboot', '--no-prompt'],
            Gio.SubprocessFlags.NONE);
    } catch (e) {
        Gio.DBus.system.call(
            'org.freedesktop.login1',
            '/org/freedesktop/login1',
            'org.freedesktop.login1.Manager',
            'Reboot', new GLib.Variant('(b)', [false]), null,
            Gio.DBusCallFlags.NONE, -1, null, () => {});
    }
}