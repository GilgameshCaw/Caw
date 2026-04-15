import ByteWriter from './ByteWriter';
import SmlContext from './SmlContext';
import {encodeSizes} from './sizeEncoding';

export default class TableBuilder {
  symbolSizeByCtx = Array.from({length: SmlContext.count}).map(() =>
    Array.from<number>({length: 256}).fill(0),
  );

  addData(s: string) {
    const ctx = new SmlContext();

    for (const byte of new TextEncoder().encode(s)) {
      this.symbolSizeByCtx[ctx.i][byte] += 1;
      ctx.push(byte);
    }
  }

  build() {
    const writer = new ByteWriter();

    for (const bc of this.symbolSizeByCtx) {
      for (const b of encodeSizes(bc)) {
        writer.write(b);
      }
    }

    return writer.finish();
  }
}
