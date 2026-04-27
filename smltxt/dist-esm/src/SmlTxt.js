import BitReader from './BitReader.js';
import BitWriter from './BitWriter.js';
import ByteWriter from './ByteWriter.js';
import SmlContext from './SmlContext.js';
import parseTableData from './parseTableData.js';
import tableData from './tableData.js';
let lastFetch;
async function getTableData(url) {
    if (lastFetch?.url === url) {
        if (lastFetch.complete) {
            return lastFetch.tableData;
        }
        try {
            const tableData = await lastFetch.tableData;
            return tableData;
        }
        catch {
            if (lastFetch?.url === url && !lastFetch.complete) {
                lastFetch = undefined;
            }
            return getTableData(url);
        }
    }
    const tableDataPromise = (async () => {
        const resp = await fetch(url);
        const buf = new Uint8Array(await resp.arrayBuffer());
        return buf;
    })();
    lastFetch = {
        url,
        complete: false,
        tableData: tableDataPromise,
    };
    const tableData = await tableDataPromise;
    if (lastFetch?.url === url && !lastFetch.complete) {
        lastFetch = {
            url,
            complete: true,
            tableData,
        };
    }
    return tableData;
}
export default class SmlTxt {
    static async fromFetch(url) {
        return new SmlTxt(await getTableData(url));
    }
    static fromPkg() {
        return new SmlTxt(tableData);
    }
    table;
    constructor(tableData) {
        this.table = parseTableData(tableData);
    }
    compress(text) {
        const writer = new BitWriter();
        const ctx = new SmlContext();
        for (const b of new TextEncoder().encode(text)) {
            const bits = this.table.compress[ctx.i][b];
            for (let i = 0; i < bits.len; i++) {
                writer.write(bits.at(i));
            }
            ctx.push(b);
        }
        return writer.finish();
    }
    decompress(buf) {
        const reader = new BitReader(buf);
        const ctx = new SmlContext();
        const res = new ByteWriter();
        while (reader.bitsRemaining() > 0) {
            let tree = this.table.decompress[ctx.i];
            while (!('symbol' in tree)) {
                tree = reader.read() ? tree.right : tree.left;
            }
            res.write(tree.symbol);
            ctx.push(tree.symbol);
        }
        return new TextDecoder().decode(res.finish());
    }
}
