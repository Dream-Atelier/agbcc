# agbcc — Klonoa Empire of Dreams fork

This is a fork of [Dream-Atelier/agbcc](https://github.com/Dream-Atelier/agbcc)
(itself a descendant of [pret/agbcc](https://github.com/pret/agbcc)), the
GCC 2.95-based C compiler used to match GBA decompilations byte-for-byte.

## What this fork adds

Six instrumentation flags designed for use by coding agents (LLMs) doing
matching-decompilation work. All are **diagnostic only** — they emit asm
comments or stderr lines, never alter the bytes the assembler sees, so
enabling any of them keeps the ROM SHA1 stable.

In the parent project (`klonoa-empire-of-dreams/Makefile`) all flags are
on by default behind an opt-out: set `AGENT_INSTRUMENT=0` to disable.

### `-finstrument-src-locs`

Emits `@ src:file.c:LINE` asm comments before each insn group whose RTL
came from that source line. Lets you read the `.s` output as annotated
source, rather than reverse-engineering which C line produced which
instructions by counting.

Implementation: hooks `output_source_line` in `gcc/final.c` and forces
`no_line_numbers=0` during `init_emit_once` so `emit_line_note` actually
produces NOTE rtxes at `-O2` without `-g`. The case-NOTE branch in
`final_scan_insn` was breaking early when `write_symbols == NO_DEBUG`;
that early-break was also lifted so the line-number path actually fires.

### `-fdump-function-size`

Prints `agbcc-size: FOO bytes=NNN` to stderr at the end of each
function. Uses `insn_current_address` (last-insn offset). Excludes
`FUNCTION_EPILOGUE` bytes so the absolute number is an approximation,
but the **delta** between two builds of the same function is exact.

Workflow: edit C, `rm build/src/foo.o && make build/src/foo.o`, grep the
stderr for the function name. If the byte count moved, your edit
changed codegen; if it's identical you can skip `make compare` for that
function.

Implementation: hook in `final_end_function` (`gcc/final.c`), reads
`current_function_decl` to print the symbol name.

### `-fdump-reg-lifetimes`

Per-function summary: which hard registers were referenced in
`PATTERN(insn)` at final emission, and the first/last source line each
register appeared at.

```
agbcc-reglife: FadeOutController r0=22-33 r1=26-33 r4=18-32
```

Catches a failure mode `-fdump-function-size` alone can't: when an edit
produces the **same byte count** but **different bytes** because agbcc
reshuffled which pseudo-reg went into which hard reg. The lifetime
shifts (e.g. `r0=22-33` → `r0=22-30`, `r4=18-32` → `r4=24-32`) reveal
the reshuffle before SHA1 verification.

Implementation: two `int[FIRST_PSEUDO_REGISTER]` arrays in `final.c`
reset in `final_start_function`, populated by a `for_each_rtx` callback
walking each insn body in the INSN/JUMP_INSN/CALL_INSN default case of
`final_scan_insn`. Also bypasses `emit_note`'s same-line dedup so insns
correlate to their producing C line.

### `-fdump-pool-literals`

For each fresh literal-pool entry, prints to stderr if the value looks
like an unnamed ROM/IWRAM address:

```
agbcc-pool-literal: 0x08051FE8 in InitLevelFromROMTable
agbcc-pool-literal: gUnk_03003430+0x48 in InitLevelFromROMTable
```

Two shapes are reported:

1. plain `CONST_INT` in `0x02000000`..`0x09000000` (the GBA's RAM + ROM
   ranges)
2. `CONST(PLUS(SYMBOL_REF base, CONST_INT offset))` — the `sym + N`
   pattern the C source produces when no extern exists at the computed
   address (cast-cascade smell)

Surfaces candidates for adding `extern T gFoo;` + ldscript bindings —
exactly the cleanup that, in our codebase, collapsed a 70-character
cast cascade in `InitLevelFromROMTable` into a single typed array
access.

Implementation: hook in `gcc/thumb.c:add_constant` (~25 lines).

### Inherited from pret/agbcc and Dream-Atelier

The agent flags coexist with the two pre-existing non-upstream options
the project relies on, kept untouched:

- **`-fhex-asm`** — emit immediates in hex instead of decimal. Used by
  every GBA matching decomp.
- **`-fprologue-bugfix`** — prevent unnecessary `lr` saves to the stack
  in functions where they aren't required. Without this, agbcc emits a
  prologue that doesn't match the original ROM in many functions. The
  flag itself is `#ifndef OLD_COMPILER`-gated so it's only available in
  the new agbcc (not `old_agbcc`).

## Debug-info fixes (`-g`)

Unlike the flags above, these are **bug fixes**: agbcc's DWARF output was
both link-breaking and unreadable, so `-g` was effectively unusable on a
real project. Neither fix is opt-in and neither changes code generation —
debug sections are non-alloc, and with `-g` off the compiler's output is
byte-identical to before the change. ROM SHA1s are unaffected.

Why bother: a matching build compiled with `-g` records, for every function
it compiles, the declaration shape of each global it sees and the function's
own signature. That turns the built ELF into a machine-readable description
of the project's types — which is what
[asmlift](https://github.com/macabeus/asmlift) reads to name and type
globals when decompiling. Before these fixes there was no way to get it out
of agbcc.

### A label DIE could point at a label that no longer exists

At `-O` the optimizer can delete the `CODE_LABEL` of a user-declared label —
a `goto` target whose block cross-jumping merges away. The `LABEL_DECL`
survives, so `gen_label_die` still emitted `DW_AT_low_pc` referencing
`.LI<funcdef>_<uid>`, but `final` never emitted that label. The result is a
`.debug_info` reference to an undefined symbol, which assembles fine and
then **fails the link**, naming a compiler-internal label the user cannot
act on:

```
arm-none-eabi-ld: src/game/stage/player.o:(.debug_info+0xe367):
  undefined reference to `.LI429_823'
```

The pre-existing guard caught only `INSN_DELETED_P`, which this case does
not set. `final` runs before `dwarf2out_decl` generates the DIEs
(`toplev.c:rest_of_compilation`), so which labels exist is already known:
`dwarf2out_label` now records the `INSN_UID` of each label it emits, and
`gen_label_die` adds the attribute only for those. The DIE is still emitted
either way — a label described without an address is correct and useful; one
pointing at a symbol that was never defined is not.

Sonic Advance 3 could not build with `-g` at all before this; it now links
all 148 translation units with its SHA1 unchanged.

### `.debug_abbrev` was never terminated

`output_abbrev_section` wrote the `0,0` that ends each entry's **attribute
list**, but never the single `0` byte that ends the abbreviation **table**,
which DWARF 2 (7.5.3) requires after the last entry. A conforming reader
walks off the end of the unit's table into whatever follows, so every
standard tool refused the section outright and decoded nothing:

```
readelf: Error: .debug_abbrev section not zero terminated
```

One `fprintf` after the loop. `arm-none-eabi-readelf` now parses Sonic
Advance 3's full 1.1M-line `.debug_info` with zero diagnostics (144 CUs,
2,163 subprograms), and the emitted data checks out against the sources:
every subprogram's `low_pc` resolves to a symbol really at that address, and
spot-checked signatures and struct layouts match their declarations.

## Code-level locations

For anyone reading the source:

| Flag | Implementation files |
|---|---|
| `-finstrument-src-locs` | `gcc/final.c` (`output_source_line`, the `case NOTE` line-number branch), `gcc/toplev.c` (forces `init_emit_once` line numbers), `gcc/flags.h` |
| `-fdump-function-size` | `gcc/final.c` (`final_end_function`) |
| `-fdump-reg-lifetimes` | `gcc/final.c` (per-reg arrays, `record_hard_reg_use`, the INSN default case), `gcc/emit-rtl.c` (dedup bypass) |
| `-fdump-pool-literals` | `gcc/thumb.c` (`add_constant`, `report_pool_literal`) |
| DWARF label fix | `gcc/dwarf2out.c` (`dwarf2out_label`, `gen_label_die`, `note_emitted_label`/`label_was_emitted`) |
| DWARF abbrev terminator | `gcc/dwarf2out.c` (`output_abbrev_section`) |

All flags declared in `gcc/flags.h` and `gcc/toplev.c`'s `f_options[]`
table near the existing `-fhex-asm`/`-fprologue-bugfix` entries.

## Building

Standard agbcc build flow — no changes from upstream:

```sh
./build.sh
./install.sh ../..   # if you want to install into the parent decomp
```

The setup script in the parent project (`./setup.sh`) handles caching
based on the commit hash of this submodule, so changes here trigger a
rebuild on next `make`.

## Why a fork

The two pre-existing patches (`-fhex-asm`, `-fprologue-bugfix`) are
shared with pret/agbcc and Dream-Atelier and are required for matching
GBA decomps. The agent-instrumentation flags above are specific to this
project's workflow of having a coding agent participate in
matching-decompilation work — they aren't intended as upstream
contributions to pret/agbcc, but the diff is small and self-contained
if someone wants them.

The **debug-info fixes are a different case**: they are plain bugs, they
affect every agbcc-based project that tries to build with `-g`, and they
are opt-in to nothing. They belong upstream, and porting them is two
self-contained hunks in `gcc/dwarf2out.c`.
