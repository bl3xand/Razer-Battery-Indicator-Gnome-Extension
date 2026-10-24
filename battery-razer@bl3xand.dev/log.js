// Journal logging behind the DEBUG flag. The call sites still build their
// argument strings eagerly, so guard them with `if (DEBUG)` where the
// string construction is non-trivial.
import {DEBUG} from './constants.js';

/** Debug log, greppable in the journal as "battery-razer". */
export function debug(...args) {
    if (DEBUG)
        console.log(`battery-razer: ${args.join(' ')}`);
}