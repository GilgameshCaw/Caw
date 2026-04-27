"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = parseTableData;
const SmlContext_1 = __importDefault(require("./SmlContext"));
const huff_1 = require("./huff");
const sizeEncoding_1 = require("./sizeEncoding");
function parseTableData(stream) {
    const table = {
        compress: [],
        decompress: [],
    };
    for (let i = 0; i < SmlContext_1.default.count; i++) {
        const encodedSizes = stream.subarray(256 * i, 256 * (i + 1));
        const sizes = (0, sizeEncoding_1.decodeSizes)(encodedSizes);
        table.decompress.push((0, huff_1.buildHuffTree)(sizes));
    }
    for (const tree of table.decompress) {
        table.compress.push((0, huff_1.huffTreeToBitArrays)(tree));
    }
    return table;
}
