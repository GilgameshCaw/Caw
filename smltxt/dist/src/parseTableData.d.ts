import type BitArray from './BitArray';
import { type HuffTree } from './huff';
export type SmlTable = {
    compress: BitArray[][];
    decompress: HuffTree[];
};
export default function parseTableData(stream: Uint8Array): {
    compress: BitArray[][];
    decompress: HuffTree[];
};
