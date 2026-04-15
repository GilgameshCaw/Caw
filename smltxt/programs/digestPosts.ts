import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

async function parseStream(
  directory: string,
  onPost: (post: string) => void,
) {
  // Read all files in the directory
  const files = fs.readdirSync(directory, {recursive: true, encoding: 'utf8'});

  // Filter for JSON files
  const jsonFiles = files.filter((file) => path.extname(file) === '.json');

  // Process each JSON file
  for (const file of jsonFiles) {
    const filePath = path.join(directory, file);

    // Read file line by line
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    // Parse each line as JSON
    for await (const line of rl) {
      let jsonLine: any;

      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        jsonLine = JSON.parse(line);

        for (const post of jsonLine.includes.posts ?? []) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          onPost(post.text);
        }
      } catch (error) {
        console.error(`Error parsing JSON in file ${file}, line: ${line}`);
        throw error;
      }
    }
  }
}

const writeStream = fs.createWriteStream('data/posts.json', 'utf8');

parseStream('data/post-stream', (post) => {
  writeStream.write(`${JSON.stringify(post)}\n`);
})
  .then(() => {
    writeStream.close();
  })
  .catch(console.error);
