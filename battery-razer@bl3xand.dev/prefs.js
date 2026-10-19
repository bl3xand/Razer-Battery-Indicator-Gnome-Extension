import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {ExtensionPreferences, gettext as _} from
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class RazerBatteryPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('Razer Battery'),
            icon_name: 'battery-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: _('Behavior'),
            description: _('Razer battery indicator settings'),
        });
        page.add(group);

        const threshold = new Adw.SpinRow({
            title: _('Notification threshold, %'),
            subtitle: _('Notify when the charge drops below this level'),
            adjustment: new Gtk.Adjustment({
                value: 20, lower: 5, upper: 50,
                step_increment: 5, page_increment: 10,
            }),
        });
        settings.bind('low-threshold', threshold, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(threshold);

        window.add(page);
    }
}