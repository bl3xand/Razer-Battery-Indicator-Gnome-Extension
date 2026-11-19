#!/usr/bin/env python3
"""Run isolated checks without enabling GNOME extensions or touching HID devices."""
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT)

def run(args, **kwargs):
    subprocess.run(args, check=True, timeout=30, **kwargs)

for p in [*(ROOT/'battery-razer@bl3xand.dev').glob('*.js'), ROOT/'packaging/store-actions.js']:
    run(['node', '--check', str(p)])
run(['node', '--experimental-vm-modules', '--test', 'tests/regression.test.mjs'])
# Inspect the actual installed GJS wrapper, not a mock of the native ABI.
for mutter in sorted(Path('/usr/lib').glob('mutter-*')):
    version = mutter.name.removeprefix('mutter-')
    if not (mutter / f'Meta-{version}.typelib').exists():
        continue
    env = os.environ.copy()
    env['GI_TYPELIB_PATH'] = str(mutter)
    env['LD_LIBRARY_PATH'] = str(mutter)
    signature = subprocess.check_output(['gjs', '-c',
        f"imports.gi.versions.Meta='{version}'; print(imports.gi.Meta.IdleMonitor.prototype.add_idle_watch_full);"],
        env=env, text=True, timeout=10)
    assert 'interval_msec, callback, flags' in signature, signature
    print('Native Mutter idle-watch callback signature passed')
    break
run(['bash', '-n', 'install-driver.sh'])
with tempfile.TemporaryDirectory(prefix='.native-test-', dir=ROOT) as tmp:
    p = Path(tmp)
    for name, level, status in [('0003:1532:00D7.0001', '0', '0'),
                              ('0003:1532:00D7.0002', '204', '1'),
                              ('0003:1532:00D6.0003', '0', '0'),
                              ('0003:9999:9999.0004', '255', '1')]:
        (p/name).mkdir()
        (p/name/'charge_level').write_text(level+'\n')
        (p/name/'charge_status').write_text(status+'\n')
    (p/'invalid').write_text('25junk\n')
    (p/'out-of-range').write_text('256\n')
    run(['gjs', '-m', 'tests/native-smoke.js', str(p)])
    script = (ROOT/'install-driver.sh').read_text()
    function = re.search(r'^kernel_headers\(\) \{\n.*?^\}', script, re.M|re.S).group()
    for release, pkgbase in [('7.3.4-arch1-2', 'linux'), ('6.12.8-1-lts', 'linux-lts'),
                             ('6.6.14-2-MANJARO', 'linux66'), ('7.3.4-zen1-1-zen', 'linux-zen')]:
        (p/release).mkdir(); (p/release/'pkgbase').write_text(pkgbase+'\n')
        output = subprocess.check_output(['bash', '-c', function+'\nkernel_headers "$@"',
                                          'test', release, tmp], text=True)
        assert output.strip() == pkgbase+'-headers'
    result = subprocess.run(['bash', '-c', function+'\nkernel_headers "$@"',
                             'test', 'unknown-kernel', tmp], capture_output=True)
    assert result.returncode != 0
run(['glib-compile-schemas', '--strict', '--dry-run', 'battery-razer@bl3xand.dev/schemas'])
run(['python3', 'packaging/build.py'])
first = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT/'dist').glob('*.zip')}
run(['python3', 'packaging/build.py'])
assert first == {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT/'dist').glob('*.zip')}
with zipfile.ZipFile(ROOT/'dist/battery-razer@bl3xand.dev-store.zip') as store:
    assert 'schemas/gschemas.compiled' not in store.namelist()
    assert 'LICENSE' in store.namelist()
    for name in store.namelist():
        assert not name.startswith('/') and '..' not in Path(name).parts
        if name.endswith('.js'):
            assert not any(x in store.read(name) for x in [b'Gio.Subprocess', b'curl -', b"'bash'", b'gnome-session-quit', b'DRIVER_SETUP_RAW'])
    assert 'version' not in json.loads(store.read('metadata.json'))
with zipfile.ZipFile(ROOT/'dist/battery-razer@bl3xand.dev.zip') as local:
    assert 'schemas/gschemas.compiled' in local.namelist()
    assert b'Gio.Subprocess' in local.read('actions.js')
print('All isolated checks passed; live GNOME and real HID devices were not exercised.')
