export default class Base64 {
    static encode(buf: Uint8Array): string;
    static decode(stringData: string): Uint8Array<ArrayBuffer>;
}
