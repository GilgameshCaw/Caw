import {expect} from 'chai';
import BitWriter from '../src/BitWriter';
import BitReader from '../src/BitReader';

describe('BitWriter and BitReader', () => {
  it('consistent write and read', () => {
    const testCases = [
      '',
      '0',
      '1',
      '00',
      '01',
      '10',
      '11',
      '0000000',
      '1111111',
      '00000000',
      '11111111',
      '00000000000',
      '00000000001',
      '1111110',
      '10101100',
      '011100000',
      '1111110011',
      '00110010011',
      '100101101000',
      '1001110011110',
      '01110001011101',
    ];

    for (const testCase of testCases) {
      const writer = new BitWriter();

      for (const c of testCase) {
        writer.write(c === '1');
      }

      const res = writer.finish();
      const reader = new BitReader(res);

      for (const c of testCase) {
        expect(reader.read()).to.eq(c === '1');
      }

      expect(reader.bitsRemaining()).to.eq(0);
    }
  });
});
