export function convertBigIntsToStrings(input: any): any {
  if (typeof input === "bigint") return input.toString();

  if (Array.isArray(input)) {
    return input.map(convertBigIntsToStrings);
  }

  if (input && typeof input === "object") {
    // Handle possible SuperJSON BigInt shape: { $type: 'BigInt', value: '...' }
    const maybe = input as Record<string, unknown>;
    if (maybe.$type === "BigInt" && typeof maybe.value === "string") {
      return maybe.value; // keep as string
    }
    return Object.fromEntries(
      Object.entries(maybe).map(([key, value]) => [key, convertBigIntsToStrings(value)])
    );
  }

  return input;
}

