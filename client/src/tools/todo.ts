export default function todo<T>(msg = 'implement me'): T {
  throw new Error(`TODO: ${msg}`);
}
