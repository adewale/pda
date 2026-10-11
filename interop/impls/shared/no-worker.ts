/**
 * Stands in for `src/index.ts` in the mock Company's bundle. In tests the
 * mock fetches our agent's documents from the Worker directly; behind the
 * interop proxy it fetches them over the network like any other client's,
 * so this is never called.
 */
export default {
  fetch(): Promise<Response> {
    throw new Error("The interop mock Company fetches agents over the network");
  }
};
