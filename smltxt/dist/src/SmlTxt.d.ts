import { type SmlTable } from './parseTableData';
export default class SmlTxt {
    static fromFetch(url: string): Promise<SmlTxt>;
    static fromPkg(): SmlTxt;
    table: SmlTable;
    constructor(tableData: Uint8Array);
    compress(text: string): Uint8Array<ArrayBufferLike>;
    decompress(buf: Uint8Array): string;
}
