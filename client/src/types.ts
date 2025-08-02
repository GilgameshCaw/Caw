import type Hash from './tools/Hash';

export type RawEvent = {
  i: number;
  txHash: Hash;
  blockTime: Date;
  cawonce: number;
  data: Uint8Array;
  parentHash: Hash;
};
