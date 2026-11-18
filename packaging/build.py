#!/usr/bin/env python3
"""Build reproducible Git and EGO packages from the same source tree."""
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'battery-razer@bl3xand.dev'
DIST = ROOT / 'dist'
FILES = ['extension.js', 'battery.js', 'activity.js', 'constants.js', 'actions.js',
         'mouseIcon.js', 'log.js', 'prefs.js', 'metadata.json',
         'schemas/org.gnome.shell.extensions.battery-razer.gschema.xml']

def build(store):
    content = {name: (SOURCE / name).read_bytes() for name in FILES}
    content['LICENSE'] = (ROOT / 'LICENSE').read_bytes()
    if store:
        content['actions.js'] = (ROOT / 'packaging/store-actions.js').read_bytes()
        constants = content['constants.js'].decode()
        constants = re.sub(r'// Raw script URL.*?export const DRIVER_SETUP_RAW =\n[^;]+;\n', '', constants, flags=re.S)
        content['constants.js'] = constants.encode()
        metadata = json.loads(content['metadata.json'])
        metadata.pop('version', None)
        metadata['description'] = 'Battery level of Razer wireless mice in the panel. Requires the OpenRazer kernel driver. Asynchronous serial reads, sleep-aware caching, hotplug monitoring and configurable low-battery notifications. Driver setup instructions are available from the menu.'
        content['metadata.json'] = (json.dumps(metadata, indent=2) + '\n').encode()
        assert not any(word in content['actions.js'] for word in (b'Subprocess', b'curl', b'bash', b'Reboot'))
        assert b'DRIVER_SETUP_RAW' not in content['constants.js']
    else:
        with tempfile.TemporaryDirectory(prefix='.schema-build-', dir=ROOT) as directory:
            folder = Path(directory)
            schema = 'org.gnome.shell.extensions.battery-razer.gschema.xml'
            (folder / schema).write_bytes(content['schemas/' + schema])
            subprocess.run(['glib-compile-schemas', '--strict', str(folder)], check=True)
            content['schemas/gschemas.compiled'] = (folder / 'gschemas.compiled').read_bytes()
    DIST.mkdir(exist_ok=True)
    suffix = '-store' if store else ''
    target = DIST / f'battery-razer@bl3xand.dev{suffix}.zip'
    temporary = target.with_suffix('.zip.new')
    try:
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name, data in sorted(content.items()):
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, data)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    print(f'{target.name}: {hashlib.sha256(target.read_bytes()).hexdigest()}')

if __name__ == '__main__':
    build(False)
    build(True)
