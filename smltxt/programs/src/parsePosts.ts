import fs from 'node:fs';
import readline from 'node:readline';

export default async function parsePosts(
  filePath: string,
  onPost: (post: string) => void,
) {
  // Read file line by line
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  // Parse each line as JSON
  for await (const line of rl) {
    let post: any;

    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      post = JSON.parse(line);

      if (typeof post !== 'string') {
        throw new TypeError('unexpected non-string post');
      }

      onPost(post);
    } catch (error) {
      console.error(`Error parsing JSON in file ${filePath}, line: ${line}`);
      throw error;
    }
  }
}
