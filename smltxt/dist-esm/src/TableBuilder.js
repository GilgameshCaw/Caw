import ByteWriter from './ByteWriter.js';
import SmlContext from './SmlContext.js';
import { encodeSizes } from './sizeEncoding.js';
export default class TableBuilder {
    symbolSizeByCtx = Array.from({ length: SmlContext.count }).map(() => Array.from({ length: 256 }).fill(0));
    addData(s) {
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
