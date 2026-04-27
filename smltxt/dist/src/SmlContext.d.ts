export default class SmlContext {
    static count: number;
    static from(prefix: string): SmlContext;
    i: number;
    push(byte: number): void;
}
export declare function downSample(byte: number): number;
