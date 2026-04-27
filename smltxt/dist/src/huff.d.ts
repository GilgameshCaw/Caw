import BitArray from './BitArray';
export type HuffLeaf = {
    size: number;
    symbol: number;
};
export type HuffTree = HuffLeaf | {
    size: number;
    left: HuffTree;
    right: HuffTree;
};
export declare function buildHuffTree(symbolSizes: number[]): HuffTree;
export declare function huffTreeToBitArrays(tree: HuffTree): BitArray[];
export declare function huffBitsNeeded(sizes: number[]): number;
export declare function theoreticalBitsNeeded(sizes: number[]): number;
