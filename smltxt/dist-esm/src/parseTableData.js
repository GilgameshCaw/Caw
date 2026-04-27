import SmlContext from './SmlContext.js';
import { buildHuffTree, huffTreeToBitArrays } from './huff.js';
import { decodeSizes } from './sizeEncoding.js';
export default function parseTableData(stream) {
    const table = {
        compress: [],
        decompress: [],
    };
    for (let i = 0; i < SmlContext.count; i++) {
        const encodedSizes = stream.subarray(256 * i, 256 * (i + 1));
        const sizes = decodeSizes(encodedSizes);
        table.decompress.push(buildHuffTree(sizes));
    }
    for (const tree of table.decompress) {
        table.compress.push(huffTreeToBitArrays(tree));
    }
    return table;
}
