import fs from 'node:fs';
import TableBuilder from '../src/TableBuilder';
import parsePosts from './src/parsePosts';

async function main() {
  const builder = new TableBuilder();

  await parsePosts('data/train-posts.json', (post) => {
    builder.addData(post);
  });

  fs.writeFileSync('data/table.dat', builder.build());
}

main().catch(console.error);
