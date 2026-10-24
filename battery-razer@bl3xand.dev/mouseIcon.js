// Panel icon: the owner's mouse silhouette drawn straight from a potrace
// path — no image files, no GdkPixbuf, no icon-theme installation. Cairo
// fills the path with the color contrasting the panel color-scheme.
import cairo from 'gi://cairo';
import Gio from 'gi://Gio';

// potrace output of the silhouette (SVG viewBox 512; the group transform
// translate(0,512) scale(0.1,-0.1) is applied when drawing).
// Path grammar: M abs-move, m rel-move (new subpath), l rel-lines,
// c rel-cubics, z close.
export const MOUSE_PATH = 'M1990 5109 c-577 -74 -1035 -496 -1162 -1072 '
    + 'l-23 -102 0 -1375 0 -1375 23 -102 '
    + 'c118 -534 517 -935 1050 -1054 91 -21 129 -22 607 -26 551 -5 658 1 '
    + '816 43 503 134 876 530 986 1044 17 80 18 171 18 1470 0 1299 -1 1390 '
    + '-18 1470 -55 257 -173 483 -347 664 -177 184 -370 302 -610 372 '
    + '-161 48 -254 54 -785 53 -269 -1 -519 -5 -555 -10z '
    + 'm420 -471 l0 -183 -58 -27 '
    + 'c-112 -53 -200 -154 -241 -276 -20 -57 -21 -84 -21 -387 0 -303 1 -330 '
    + '21 -387 41 -122 129 -223 241 -276 l58 -27 0 -201 '
    + 'c0 -192 1 -203 23 -234 62 -92 181 -90 251 4 19 25 21 44 24 231 '
    + 'l4 203 64 32 c125 64 221 198 243 340 14 84 14 546 0 630 -22 143 '
    + '-118 276 -244 340 l-65 33 0 183 0 184 161 0 '
    + 'c173 0 265 -10 374 -42 361 -104 631 -378 732 -743 l28 -100 0 -1375 '
    + '0 -1375 -28 -100 c-100 -362 -369 -637 -720 -739 -152 -44 -209 -48 '
    + '-752 -44 l-510 4 -97 26 c-191 52 -352 144 -487 279 -134 135 -226 295 '
    + '-279 487 l-27 97 0 1365 0 1365 27 97 '
    + 'c99 358 351 628 692 743 120 40 217 53 409 54 l177 1 0 -182z '
    + 'm195 -469 c50 -14 100 -64 114 -114 7 -24 11 -139 11 -290 0 -151 '
    + '-4 -266 -11 -290 -22 -77 -115 -136 -192 -120 -46 10 -93 44 -116 86 '
    + '-20 35 -21 53 -21 325 0 275 1 291 21 323 46 77 111 103 194 80z';

/** Panel text is dark (light theme) or light (dark theme). */
export function panelTextIsDark() {
    panelTextIsDark._settings ??= new Gio.Settings(
        {schema_id: 'org.gnome.desktop.interface'});
    try {
        const scheme = panelTextIsDark._settings.get_string('color-scheme');
        return scheme.includes('light') && !scheme.includes('prefer-dark');
    } catch (e) {
        return false; // default to light text (dark theme)
    }
}

// MOUSE_PATH parsed once into flat command runs [cmd, ...numbers]; painting
// replays them without re-running the regex on every repaint.
const PATH_RUNS = (() => {
    const re = /([Mmlcz])|(-?\d+\.?\d*)/g;
    const runs = [];
    let m;
    while ((m = re.exec(MOUSE_PATH)) !== null) {
        if (m[1] !== undefined) {
            if (m[1] === 'z')
                runs.push(['z']);
            else
                runs.push([m[1]]);
        } else {
            runs[runs.length - 1].push(parseFloat(m[2]));
        }
    }
    return runs;
})();

/** Draw MOUSE_PATH filled on the given Cairo context, fitted into size. */
export function paintMouse(cr, size, dark) {
    cr.save();
    // viewBox 512 -> DrawingArea pixels, then the SVG group transform.
    cr.scale(size / 512, size / 512);
    cr.scale(0.1, 0.1);
    cr.translate(0, 5120);
    cr.scale(1, -1);
    let x = 0, y = 0;
    for (const run of PATH_RUNS) {
        const cmd = run[0];
        if (cmd === 'z') {
            cr.closePath();
        } else if (cmd === 'M') {
            x = run[1]; y = run[2];
            cr.moveTo(x, y);
        } else if (cmd === 'm') {
            x += run[1]; y += run[2];
            cr.moveTo(x, y);
        } else if (cmd === 'l') {
            for (let i = 1; i < run.length; i += 2) {
                x += run[i]; y += run[i + 1];
                cr.lineTo(x, y);
            }
        } else if (cmd === 'c') {
            for (let i = 1; i < run.length; i += 6) {
                const x1 = run[i], y1 = run[i + 1];
                const x2 = run[i + 2], y2 = run[i + 3];
                const x3 = run[i + 4], y3 = run[i + 5];
                cr.curveTo(x + x1, y + y1, x + x2, y + y2, x + x3, y + y3);
                x += x3; y += y3;
            }
        }
    }
    cr.setFillRule(cairo.FillRule.EVEN_ODD);
    cr.setSourceRGBA(dark ? 0 : 1, dark ? 0 : 1, dark ? 0 : 1, 1);
    cr.fill();
    cr.restore();
}