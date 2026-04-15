import type BitArray from './BitArray';
import SmlContext from './SmlContext';
import {type HuffTree, buildHuffTree, huffTreeToBitArrays} from './huff';
import {decodeSizes} from './sizeEncoding';

export type SmlTable = {
  compress: BitArray[][];
  decompress: HuffTree[];
};

export default function parseTableData(stream: Uint8Array): {
  compress: BitArray[][];
  decompress: HuffTree[];
} {
  const table: SmlTable = {
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
