/** Resolve the repository's extensionless TypeScript ESM imports in native worker threads. */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined;
    if (
      code !== 'ERR_MODULE_NOT_FOUND' ||
      !specifier.startsWith('.') ||
      /\.[a-z0-9]+$/i.test(specifier)
    ) {
      throw error;
    }
    for (const extension of ['.ts', '.js']) {
      try {
        return await nextResolve(`${specifier}${extension}`, context);
      } catch {
        // Try the next source extension; preserve the first resolver error if neither exists.
      }
    }
    throw error;
  }
}
