// eslint-disable-next-line unicorn/no-static-only-class, @typescript-eslint/no-extraneous-class
export default class Base64 {
    static encode(buf) {
        // eslint-disable-next-line no-restricted-globals
        return btoa(String.fromCharCode.apply(null, Array.from(buf)));
    }
    static decode(stringData) {
        // eslint-disable-next-line no-restricted-globals
        const binaryString = atob(stringData);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            // eslint-disable-next-line unicorn/prefer-code-point
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes;
    }
}
