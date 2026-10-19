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
            title: _('Поведение'),
            description: _('Настройки индикатора батареи Razer'),
        });
        page.add(group);

        const poll = new Adw.SpinRow({
            title: _('Интервал опроса, секунд'),
            subtitle: _('Как часто перечитывать уровень заряда'),
            adjustment: new Gtk.Adjustment({
                value: 60, lower: 10, upper: 600,
                step_increment: 10, page_increment: 60,
            }),
        });
        settings.bind('poll-seconds', poll, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(poll);

        const threshold = new Adw.SpinRow({
            title: _('Порог уведомления, %'),
            subtitle: _('Уведомлять при разряде ниже этого уровня'),
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