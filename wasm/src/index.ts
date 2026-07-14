// agbcc
//
// Compile C to a Game Boy Advance ARM ELF object entirely in the browser: agbcc
// (the Thumb cc1) lowers C to ARMv4T Thumb assembly, GNU `as` assembles it to a
// relocatable .o — both compiled to WebAssembly. The .o is byte-identical to the
// native agbcc + arm-none-eabi-as toolchain for the same input and flags.
//
// The two wasm modules (dist/agbcc.{mjs,wasm}, dist/as.mjs + dist/as-new.wasm)
// are emscripten ES modules that locate their .wasm via `import.meta.url`, so a
// bundler emits the wasm as an asset (no asset wiring on the consumer's side).
// They are code-split and loaded lazily on first use; a fresh module instance is
// created per compile, because cc1/as are one-shot programs that don't reset
// global state between runs.
import config from './config.json';

export const AGBCC_FLAGS: string[] = config.agbccFlags;
export const AS_ARGS: string[] = config.asArgs;
export const ASM_TRAILER: string = config.asmTrailer;

const factories: Record<string, Promise<EmFactory> | undefined> = {};

function loadFactory(name: 'agbcc' | 'as'): Promise<EmFactory> {
  const mod = (name === 'agbcc' ? import('../dist/agbcc.mjs') : import('../dist/as.mjs'));
  return (factories[name] ??= mod.then((m) => m.default));
}

/** Warm both wasm modules ahead of the first compile. */
export function preloadAgbcc(): void {
  void loadFactory('agbcc');
  void loadFactory('as');
}

// Minimal preprocessor: agbcc reads PREPROCESSED C (it is cc1, not cpp), so the
// context's object-like `#define`s must be expanded here. Inputs forbid
// `#include` and only use object-like macros, so a whole-word textual expansion
// (re-scanned for nested macros) matches what the native cpp produces. Other
// `#` directives are dropped.
function preprocess(text: string): string {
  const macros: [string, string][] = [];
  const body: string[] = [];
  for (const line of text.split('\n')) {
    const def = line.match(/^\s*#\s*define\s+([A-Za-z_]\w*)\s+(.*)$/);
    if (def) {
      macros.push([def[1], def[2].trim()]);
      continue;
    }
    if (/^\s*#/.test(line)) {
      continue;
    }
    body.push(line);
  }
  let out = body.join('\n');
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const [name, value] of macros) {
      const next = out.replace(new RegExp(`\\b${name}\\b`, 'g'), value);
      if (next !== out) {
        out = next;
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  return out;
}

interface StageResult {
  code: number;
  stderr: string;
  FS: EmFS;
}

async function runStage(
  name: 'agbcc' | 'as',
  args: string[],
  inputs: Record<string, Uint8Array | string>,
): Promise<StageResult> {
  const factory = await loadFactory(name);
  let stderr = '';
  const Module = await factory({
    noInitialRun: true,
    print: () => {},
    printErr: (s: string) => {
      stderr += `${s}\n`;
    },
  });
  for (const [path, data] of Object.entries(inputs)) {
    Module.FS.writeFile(path, data);
  }
  let code = 0;
  try {
    code = Module.callMain(args);
  } catch (e) {
    // emscripten throws ExitStatus { status } when the program calls exit().
    const status = (e as { status?: number } | undefined)?.status;
    code = typeof status === 'number' ? status : 1;
    if (typeof status !== 'number' && !stderr) {
      stderr += String(e);
    }
  }
  return { code, stderr, FS: Module.FS };
}

export interface CompileOptions {
  /** Compile preamble prepended before `source` (types, externs). No #include. */
  context?: string;
  /** agbcc flags. Defaults to the canonical GBA matching flags (AGBCC_FLAGS). */
  flags?: string[];
}

export type CompileObjectResult =
  { ok: true; obj: Uint8Array; asm: string; stderr: string } | { ok: false; stderr: string };

/**
 * Compile C to an ARM ELF .o in the browser.
 *  1. minimal preprocess: prepend the context and expand object-like macros,
 *  2. agbcc: .i -> .s (Thumb assembly),
 *  3. GNU as: .s -> .o (the object file).
 */
export async function compileToObject(source: string, opts: CompileOptions = {}): Promise<CompileObjectResult> {
  const flags = opts.flags ?? AGBCC_FLAGS;

  const dotI = preprocess(`${opts.context ? `${opts.context}\n` : ''}${source}\n`);
  const cc = await runStage('agbcc', ['in.i', '-o', 'out.s', ...flags], {
    'in.i': dotI,
  });
  if (cc.code !== 0) {
    return { ok: false, stderr: cc.stderr || 'agbcc failed to compile.' };
  }

  let asm: string;
  try {
    asm = new TextDecoder().decode(cc.FS.readFile('out.s')) + ASM_TRAILER;
  } catch {
    return { ok: false, stderr: cc.stderr || 'agbcc produced no output.' };
  }

  const as = await runStage('as', [...AS_ARGS, 'in.s', '-o', 'out.o'], {
    'in.s': asm,
  });
  if (as.code !== 0) {
    return { ok: false, stderr: as.stderr || 'assembler failed.' };
  }

  return { ok: true, obj: as.FS.readFile('out.o'), asm, stderr: cc.stderr };
}

export type AssembleResult =
  { ok: true; obj: Uint8Array; stderr: string } | { ok: false; stderr: string };

/**
 * Assemble ARM/Thumb assembly text (a complete `.s`, e.g. agbcc's own textual output) to an
 * ARM ELF .o in the browser, via the bundled GNU `as`. The target-side counterpart to
 * `compileToObject`: a matching-decompiler harness assembles the reference `.s` here and diffs
 * it against a candidate `compileToObject` produced from recovered C.
 *
 * The `.s` is assembled AS-IS. Unlike `compileToObject`, no `ASM_TRAILER` is appended: a
 * complete `.s` already carries its own sections, and each function symbol is bounded by an
 * explicit `.size sym,.Lfe-sym`, so any trailing alignment padding falls outside every symbol
 * and cannot perturb a per-symbol objdiff. Assembler flags default to `AS_ARGS` — the SAME
 * flags `compileToObject` uses — so both sides of the diff come from one assembler config.
 */
export async function assemble(asm: string, opts: { args?: string[] } = {}): Promise<AssembleResult> {
  const args = opts.args ?? AS_ARGS;
  const as = await runStage('as', [...args, 'in.s', '-o', 'out.o'], { 'in.s': asm });
  if (as.code !== 0) {
    return { ok: false, stderr: as.stderr || 'assembler failed.' };
  }
  return { ok: true, obj: as.FS.readFile('out.o'), stderr: as.stderr };
}
