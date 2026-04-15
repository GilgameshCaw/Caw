import BitReader from './BitReader';
import BitWriter from './BitWriter';
import ByteWriter from './ByteWriter';
import SmlContext from './SmlContext';
import parseTableData, {type SmlTable} from './parseTableData';
import tableData from './tableData';

let lastFetch:
  | {
      url: string;
      complete: false;
      tableData: Promise<Uint8Array>;
    }
  | {
      url: string;
      complete: true;
      tableData: Uint8Array;
    }
  | undefined;

async function getTableData(url: string): Promise<Uint8Array> {
  if (lastFetch?.url === url) {
    if (lastFetch.complete) {
      return lastFetch.tableData;
    }

    try {
      const tableData = await lastFetch.tableData;
      return tableData;
    } catch {
      if (lastFetch?.url === url && !lastFetch.complete) {
        lastFetch = undefined;
      }

      return getTableData(url);
    }
  }

  const tableDataPromise = (async () => {
    const resp = await fetch(url);
    const buf = new Uint8Array(await resp.arrayBuffer());

    return buf;
  })();

  lastFetch = {
    url,
    complete: false,
    tableData: tableDataPromise,
  };

  const tableData = await tableDataPromise;

  if (lastFetch?.url === url && !lastFetch.complete) {
    lastFetch = {
      url,
      complete: true,
      tableData,
    };
  }

  return tableData;
}

export default class SmlTxt {
  static async fromFetch(url: string): Promise<SmlTxt> {
    return new SmlTxt(await getTableData(url));
  }

  static fromPkg(): SmlTxt {
    return new SmlTxt(tableData);
  }

  table: SmlTable;

  constructor(tableData: Uint8Array) {
    this.table = parseTableData(tableData);
  }

  compress(text: string) {
    const writer = new BitWriter();
    const ctx = new SmlContext();

    for (const b of new TextEncoder().encode(text)) {
      const bits = this.table.compress[ctx.i][b];

      for (let i = 0; i < bits.len; i++) {
        writer.write(bits.at(i));
      }

      ctx.push(b);
    }

    return writer.finish();
  }

  decompress(buf: Uint8Array) {
    const reader = new BitReader(buf);
    const ctx = new SmlContext();

    const res = new ByteWriter();

    while (reader.bitsRemaining() > 0) {
      let tree = this.table.decompress[ctx.i];

      while (!('symbol' in tree)) {
        tree = reader.read() ? tree.right : tree.left;
      }

      res.write(tree.symbol);
      ctx.push(tree.symbol);
    }

    return new TextDecoder().decode(res.finish());
  }
}
