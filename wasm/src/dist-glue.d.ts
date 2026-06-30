// The emscripten MODULARIZE glue in dist/ (agbcc.mjs, as.mjs) is generated
// JavaScript with no type declarations. Let's declare the modules types here.

type EmFS = {
  writeFile: (path: string, data: Uint8Array | string) => void;
  readFile: (path: string) => Uint8Array;
};
type EmModule = { callMain: (args: string[]) => number; FS: EmFS };
type EmFactory = (opts: Record<string, unknown>) => Promise<EmModule>;

declare module '*/agbcc.mjs' {
    export = EmFactory;
};

declare module '*/as.mjs' {
  export = EmFactory;
};
