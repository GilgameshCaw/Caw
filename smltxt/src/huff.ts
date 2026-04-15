import BitArray from './BitArray';
import BitWriter from './BitWriter';

export type HuffLeaf = {
  size: number;
  symbol: number;
};

export type HuffTree =
  | HuffLeaf
  | {
      size: number;
      left: HuffTree;
      right: HuffTree;
    };

export function buildHuffTree(symbolSizes: number[]) {
  if (symbolSizes.length === 0) {
    throw new Error('invalid');
  }

  // Create nodes array from probabilities
  const nodes: HuffTree[] = symbolSizes.map((size, symbol) => ({
    size,
    symbol,
  }));

  // TODOx: Improve performance by using a heap
  // Sort nodes by size
  nodes.sort((a, b) => a.size - b.size);

  while (nodes.length > 1) {
    // Take two nodes with the smallest sizes
    const left = nodes.shift()!;
    const right = nodes.shift()!;

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

export function huffTreeToBitArrays(tree: HuffTree): BitArray[] {
  const res: Array<[number, BitWriter]> = [];

  function process(writer: BitWriter, tree: HuffTree) {
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

  process(new BitWriter(), tree);

  res.sort(([symbolA], [symbolB]) => symbolA - symbolB);

  return res.map(([, writer]) => BitArray.fromBitWriterBuf(writer.finish()));
}

export function huffBitsNeeded(sizes: number[]) {
  const sum = sizes.reduce((a, b) => a + b);

  const tree = buildHuffTree(sizes);
  const bitArrays = huffTreeToBitArrays(tree);
  let averageBits = 0;

  for (const [i, size] of sizes.entries()) {
    averageBits += (size / sum) * bitArrays[i].len;
  }

  return averageBits;
}

export function theoreticalBitsNeeded(sizes: number[]) {
  const sum = sizes.reduce((a, b) => a + b);

  let averageBits = 0;

  for (const size of sizes) {
    const p = size / sum;
    averageBits += p * -Math.log2(p);
  }

  return averageBits;
}
