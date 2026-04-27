"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const BitReader_1 = __importDefault(require("./BitReader"));
const BitWriter_1 = __importDefault(require("./BitWriter"));
const ByteWriter_1 = __importDefault(require("./ByteWriter"));
const SmlContext_1 = __importDefault(require("./SmlContext"));
const parseTableData_1 = __importDefault(require("./parseTableData"));
const tableData_1 = __importDefault(require("./tableData"));
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
class SmlTxt {
    static async fromFetch(url) {
        return new SmlTxt(await getTableData(url));
    }
    static fromPkg() {
        return new SmlTxt(tableData_1.default);
    }
    table;
    constructor(tableData) {
        this.table = (0, parseTableData_1.default)(tableData);
    }
    compress(text) {
        const writer = new BitWriter_1.default();
        const ctx = new SmlContext_1.default();
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
        const reader = new BitReader_1.default(buf);
        const ctx = new SmlContext_1.default();
        const res = new ByteWriter_1.default();
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
exports.default = SmlTxt;
