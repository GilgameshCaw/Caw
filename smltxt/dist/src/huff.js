"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildHuffTree = buildHuffTree;
exports.huffTreeToBitArrays = huffTreeToBitArrays;
exports.huffBitsNeeded = huffBitsNeeded;
exports.theoreticalBitsNeeded = theoreticalBitsNeeded;
const BitArray_1 = __importDefault(require("./BitArray"));
const BitWriter_1 = __importDefault(require("./BitWriter"));
function buildHuffTree(symbolSizes) {
    if (symbolSizes.length === 0) {
        throw new Error('invalid');
    }
    // Create nodes array from probabilities
    const nodes = symbolSizes.map((size, symbol) => ({
        size,
        symbol,
    }));
    // TODOx: Improve performance by using a heap
    // Sort nodes by size
    nodes.sort((a, b) => a.size - b.size);
    while (nodes.length > 1) {
        // Take two nodes with the smallest sizes
        const left = nodes.shift();
        const right = nodes.shift();
        // Create a new node
        const newNode = {
            size: left.size + right.size,
            left,
            right,
        };
        // Update nodes to include the new node
        nodes.push(newNode);
        // Sort nodes by size
        nodes.sort((a, b) => a.size - b.size);
    }
    return nodes[0];
}
function huffTreeToBitArrays(tree) {
    const res = [];
    function process(writer, tree) {
        if ('symbol' in tree) {
            res.push([tree.symbol, writer]);
            return;
        }
        const rightWriter = writer.clone();
        writer.write(false);
        rightWriter.write(true);
        process(writer, tree.left);
        process(rightWriter, tree.right);
    }
    process(new BitWriter_1.default(), tree);
    res.sort(([symbolA], [symbolB]) => symbolA - symbolB);
    return res.map(([, writer]) => BitArray_1.default.fromBitWriterBuf(writer.finish()));
}
function huffBitsNeeded(sizes) {
    const sum = sizes.reduce((a, b) => a + b);
    const tree = buildHuffTree(sizes);
    const bitArrays = huffTreeToBitArrays(tree);
    let averageBits = 0;
    for (const [i, size] of sizes.entries()) {
        averageBits += (size / sum) * bitArrays[i].len;
    }
    return averageBits;
}
function theoreticalBitsNeeded(sizes) {
    const sum = sizes.reduce((a, b) => a + b);
    let averageBits = 0;
    for (const size of sizes) {
        const p = size / sum;
        averageBits += p * -Math.log2(p);
    }
    return averageBits;
}
