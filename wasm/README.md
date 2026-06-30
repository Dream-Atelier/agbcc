# agbcc

Compile C to a **Game Boy Advance ARM ELF object in the browser**. `agbcc` (the
Thumb `cc1`) lowers C to ARMv4T Thumb assembly and GNU `as` assembles it to a
relocatable `.o` — both compiled to WebAssembly.

The `.o` is **byte-identical** to the native `agbcc` + `arm-none-eabi-as` toolchain
for the same input and flags.

## Usage

```ts
import { compileToObject, preloadAgbcc } from 'agbcc';

preloadAgbcc(); // optional: warm both modules ahead of the first compile

const result = await compileToObject(source, { context });
if (result.ok) {
  result.obj; // Uint8Array — the ARM ELF .o
  result.asm; // the agbcc Thumb assembly
} else {
  result.stderr; // compiler/assembler diagnostics
}
```

No asset wiring is needed. The emscripten ES modules in `dist/` locate their
`.wasm` via `import.meta.url`, so a bundler (webpack, Vite, etc.) emits
`dist/agbcc.{mjs,wasm}` and `dist/as.mjs` + `dist/as-new.wasm` as code-split
assets automatically; both modules load lazily on first compile.

`compileToObject` runs: minimal `#define` preprocessing (agbcc is `cc1`, not
`cpp`) → agbcc `.i → .s` → GNU `as` `.s → .o`. A fresh module instance is created
per compile (cc1/as are one-shot). The canonical flags are exported as
`AGBCC_FLAGS` / `AS_ARGS` (also in `config.json`, importable by Node build steps).

## Rebuilding the WebAssembly

```sh
source <emsdk>/emsdk_env.sh
sh scripts/build.sh   # -> dist/
```

See `scripts/build.sh` for the prerequisites (emsdk, binutils source, and the two
source patches the strict wasm-ld linker needs).
