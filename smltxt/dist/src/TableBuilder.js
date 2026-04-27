"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ByteWriter_1 = __importDefault(require("./ByteWriter"));
const SmlContext_1 = __importDefault(require("./SmlContext"));
const sizeEncoding_1 = require("./sizeEncoding");
class TableBuilder {
    symbolSizeByCtx = Array.from({ length: SmlContext_1.default.count }).map(() => Array.from({ length: 256 }).fill(0));
    addData(s) {
        const ctx = new SmlContext_1.default();
        for (const byte of new TextEncoder().encode(s)) {
            this.symbolSizeByCtx[ctx.i][byte] += 1;
            ctx.push(byte);
        }
    }
    build() {
        const writer = new ByteWriter_1.default();
        for (const bc of this.symbolSizeByCtx) {
            for (const b of (0, sizeEncoding_1.encodeSizes)(bc)) {
                writer.write(b);
            }
        }
        return writer.finish();
    }
}
exports.default = TableBuilder;
