#!/bin/sh
# Build the in-browser toolchain for agbcc: agbcc (the Thumb
# cc1) and GNU as, both compiled to WebAssembly, into ./dist.
#
# The output .o is byte-identical to the native agbcc + arm-none-eabi-as toolchain
# for the same input and flags.
#
# Prerequisites:
#   - emsdk (emcc) on PATH:  source <emsdk>/emsdk_env.sh
#   - this agbcc source tree (the package lives at <agbcc>/wasm). The two
#     call-site patches it needs are committed in this repo:
#       gcc/calls.c + gcc/expr.c pass gen_call / gen_call_value exactly the 2 / 3
#       operands the thumb.md patterns declare (native K&R C ignores the extra
#       args; wasm-ld otherwise stubs every call with an `unreachable` trap).
#   - binutils source matching the arm-none-eabi-as the targets are assembled
#     with (2.43.1), patched so libiberty's psignal is skipped under emscripten:
#       libiberty/strsignal.c: `#if !defined(HAVE_PSIGNAL) && !defined(__EMSCRIPTEN__)`
#
# Override paths via env: AGBCC_SRC (default ..), BINUTILS_SRC, OUT (default ./dist).
set -e

HERE="$(cd "$(dirname "$0")/.." && pwd)"
AGBCC_SRC="${AGBCC_SRC:-$(cd "$HERE/.." && pwd)}"
BINUTILS_SRC="${BINUTILS_SRC:-$AGBCC_SRC/../binutils-2.43.1}"
OUT="${OUT:-$HERE/dist}"
mkdir -p "$OUT"

EMFLAGS="-sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORTED_RUNTIME_METHODS=callMain,FS \
  -sFORCE_FILESYSTEM=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sALLOW_MEMORY_GROWTH=1 \
  -sENVIRONMENT=web"

echo ">> 1/3  native agbcc build (generates the insn-* machine-description sources)"
# The gen* programs must run on the build host; serial because rtl.c needs genrtl.h.
( cd "$AGBCC_SRC/gcc" && make clean >/dev/null 2>&1 && make -j1 >/dev/null )

echo ">> 2/3  emcc agbcc (Thumb cc1) -> dist/agbcc.mjs/.wasm"
SRCS="toplev.c version.c tree.c print-tree.c stor-layout.c fold-const.c function.c stmt.c except.c expr.c calls.c expmed.c explow.c optabs.c varasm.c emit-rtl.c genrtl.c real.c regmove.c dwarf2out.c alias.c integrate.c jump.c cse.c loop.c unroll.c flow.c stupid.c combine.c varray.c regclass.c local-alloc.c global.c reload.c reload1.c caller-save.c gcse.c insn-peep.c final.c recog.c insn-opinit.c insn-recog.c insn-extract.c insn-output.c insn-emit.c lcm.c insn-attrtab.c thumb.c getpwd.c convert.c dyn-string.c splay-tree.c graph.c sbitmap.c resource.c c-parse.c c-lex.c c-decl.c c-typeck.c c-convert.c c-aux-info.c c-common.c c-iterate.c rtl.c bitmap.c obstack.c print-rtl.c rtlanal.c"
( cd "$AGBCC_SRC/gcc" && emcc $SRCS -std=gnu11 -I. -w -O2 \
    -Wno-error=incompatible-function-pointer-types -Wno-error=incompatible-pointer-types \
    -Wno-error=int-conversion -Wno-error=implicit-function-declaration -Wno-error=implicit-int \
    -sINITIAL_MEMORY=64MB -sSTACK_SIZE=8MB $EMFLAGS -o "$OUT/agbcc.mjs" )

echo ">> 3/3  emconfigure/emmake GNU as (arm-none-eabi) -> dist/as.mjs + dist/as-new.wasm"
BD="$BINUTILS_SRC/../build-wasm-gas"
rm -rf "$BD" && mkdir -p "$BD" && cd "$BD"
emconfigure "$BINUTILS_SRC/configure" --target=arm-none-eabi --host=wasm32-unknown-emscripten \
  --disable-nls --disable-werror --disable-ld --disable-gold --disable-binutils \
  --disable-gprof --disable-gdb --disable-gdbserver --disable-libdecnumber \
  --disable-readline --disable-sim --without-zlib --disable-plugins --disable-libctf \
  --disable-shared ac_cv_func_psignal=yes AR=emar RANLIB=emranlib >/dev/null
emmake make -j4 all-gas AR=emar RANLIB=emranlib MAKEINFO=true \
  LDFLAGS="-sINITIAL_MEMORY=32MB $EMFLAGS" >/dev/null
cp gas/as-new "$OUT/as.mjs"
cp gas/as-new.wasm "$OUT/as-new.wasm"

echo "Done -> $OUT  (agbcc.mjs/.wasm, as.mjs/as-new.wasm)"
