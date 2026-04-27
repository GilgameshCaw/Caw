"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.downSample = downSample;
class SmlContext {
    static count = 39 ** 2;
    static from(prefix) {
        const ctx = new SmlContext();
        for (const b of new TextEncoder().encode(prefix)) {
            ctx.push(b);
        }
        return ctx;
    }
    i = 0;
    push(byte) {
        this.i *= 39;
        this.i %= 39 ** 2; // Limits context length to 2
        this.i += downSample(byte);
    }
}
exports.default = SmlContext;
function downSample(byte) {
    // other, a-z, space, 0-9, punctuation
    // eslint-disable-next-line yoda
    if (65 <= byte && byte <= 90) {
        return byte - 64; // a-z => 1-26
    }
    // eslint-disable-next-line yoda
    if (97 <= byte && byte <= 122) {
        return byte - 96; // A-Z => 1-26
    }
    if (byte === 32) {
        return 27; // space => 27
    }
    // eslint-disable-next-line yoda
    if (48 <= byte && byte <= 57) {
        return byte - 20; // 0-9 => 28-37
    }
    // eslint-disable-next-line yoda
    if (33 <= byte && byte <= 126) {
        // !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
        return 38; // punctuation => 38
    }
    return 0; // Everything else => 0
}
