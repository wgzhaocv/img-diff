/* @ts-self-types="./imgdiff_wasm.d.ts" */

/**
 * compare の連続値スコア（SPEC §3）。比較不能（寸法不一致）時は呼ばない前提。
 * `pixel_equal` と `hamming_distance` はここに含めない: 前者は JS が pixelSha256
 * （両画像の crypto.subtle）の一致で、後者は `hamming_hex` で導出する（いずれも CLI
 * `compare.rs`（pixel_sha256 一致 / hash::hamming）と同じ意味に揃える）。
 */
export class CompareScores {
  static __wrap(ptr) {
    const obj = Object.create(CompareScores.prototype);
    obj.__wbg_ptr = ptr;
    CompareScoresFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    CompareScoresFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_comparescores_free(ptr, 0);
  }
  /**
   * @returns {number}
   */
  get pixel_diff_ratio() {
    const ret = wasm.comparescores_pixel_diff_ratio(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get psnr() {
    const ret = wasm.comparescores_psnr(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get ssim() {
    const ret = wasm.comparescores_ssim(this.__wbg_ptr);
    return ret;
  }
}
if (Symbol.dispose) CompareScores.prototype[Symbol.dispose] = CompareScores.prototype.free;

/**
 * 索引済み画像（`ImageRecord[]`）を厳密度でグループ化し `DupGroup[]` を返す。SPEC §5。
 * `strictness` は "exact" | "pixel" | "perceptual"。`threshold` は perceptual のみ有効（None で既定 10）。
 * @param {any} images
 * @param {string} strictness
 * @param {number | null} [threshold]
 * @returns {any}
 */
export function cluster_group(images, strictness, threshold) {
  const ptr0 = passStringToWasm0(strictness, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
  const len0 = WASM_VECTOR_LEN;
  const ret = wasm.cluster_group(
    images,
    ptr0,
    len0,
    isLikeNone(threshold) ? Number.MAX_SAFE_INTEGER : threshold >>> 0,
  );
  if (ret[2]) {
    throw takeFromExternrefTable0(ret[1]);
  }
  return takeFromExternrefTable0(ret[0]);
}

/**
 * 白平坦化済み・同寸法の RGBA 2 枚から連続値スコアをまとめて計算する（境界越えを 1 回に集約）。
 * SSIM は内部で Rec.601 グレー化してから計算する。SPEC §3。
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @param {number} width
 * @param {number} height
 * @param {number} tolerance
 * @returns {CompareScores}
 */
export function compare_scores(a, b, width, height, tolerance) {
  const ptr0 = passArray8ToWasm0(a, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(b, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ret = wasm.compare_scores(ptr0, len0, ptr1, len1, width, height, tolerance);
  return CompareScores.__wrap(ret);
}

/**
 * 白平坦化済み RGBA から 9x8 dHash（16進16文字）を計算する。SPEC §1 手順 5〜8。
 * @param {Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
export function dhash_hex(rgba, width, height) {
  let deferred2_0;
  let deferred2_1;
  try {
    const ptr0 = passArray8ToWasm0(rgba, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.dhash_hex(ptr0, len0, width, height);
    deferred2_0 = ret[0];
    deferred2_1 = ret[1];
    return getStringFromWasm0(ret[0], ret[1]);
  } finally {
    wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
  }
}

/**
 * 白平坦化済み・同寸法の RGBA 2 枚から差分ハイライト RGBA を返す（SPEC §4）。
 * 品紅=差分・淡グレー=ベース。可視化専用。
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @param {number} tolerance
 * @returns {Uint8Array}
 */
export function diff_highlight(a, b, tolerance) {
  const ptr0 = passArray8ToWasm0(a, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(b, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ret = wasm.diff_highlight(ptr0, len0, ptr1, len1, tolerance);
  var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
  wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
  return v3;
}

/**
 * wasm-vips がデコードした RGBA（sRGB・autorotate 済）を**その場で白平坦化**し、
 * 9x8 dHash を 16進16文字で返す。`rgba` は破壊的に平坦化されて JS 側へ書き戻る。SPEC §1 手順 4〜8。
 *
 * 注意（DESIGN §2.1 の二段パス）: 書き戻った平坦化 RGBA を pixelSha256（crypto.subtle）に
 * 流用できるのは**全分解能デコード時のみ**。shrink-on-load（dHash 用に 9x8 相当へ縮小デコード）
 * では返るバイトは pixelSha256 の対象ではない。その場合は 1 パス目に `dhash_hex`（書き戻し無し）を、
 * 2 パス目（衝突バケットのみ再デコード）に `flatten_on_white` を使う。呼び分けは JS オーケストレータ側。
 * @param {Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
export function flatten_and_dhash(rgba, width, height) {
  let deferred2_0;
  let deferred2_1;
  try {
    var ptr0 = passArray8ToWasm0(rgba, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    const ret = wasm.flatten_and_dhash(ptr0, len0, rgba, width, height);
    deferred2_0 = ret[0];
    deferred2_1 = ret[1];
    return getStringFromWasm0(ret[0], ret[1]);
  } finally {
    wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
  }
}

/**
 * RGBA を背景白で平坦化する（in-place・alpha=255 化）。SPEC §1 手順 4。
 * @param {Uint8Array} rgba
 */
export function flatten_on_white(rgba) {
  var ptr0 = passArray8ToWasm0(rgba, wasm.__wbindgen_malloc);
  var len0 = WASM_VECTOR_LEN;
  wasm.flatten_on_white(ptr0, len0, rgba);
}

/**
 * 2 つの dHash（16進16文字）のハミング距離 0..=64。不正な hex は None（= undefined）。
 * @param {string} a
 * @param {string} b
 * @returns {number | undefined}
 */
export function hamming_hex(a, b) {
  const ptr0 = passStringToWasm0(a, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passStringToWasm0(b, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
  const len1 = WASM_VECTOR_LEN;
  const ret = wasm.hamming_hex(ptr0, len0, ptr1, len1);
  return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
}
function __wbg_get_imports() {
  const import0 = {
    __proto__: null,
    __wbg_Error_92b29b0548f8b746: function (arg0, arg1) {
      const ret = Error(getStringFromWasm0(arg0, arg1));
      return ret;
    },
    __wbg_Number_9a4e0ecb0fa16705: function (arg0) {
      const ret = Number(arg0);
      return ret;
    },
    __wbg_String_8564e559799eccda: function (arg0, arg1) {
      const ret = String(arg1);
      const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len1 = WASM_VECTOR_LEN;
      getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
      getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    },
    __wbg___wbindgen_bigint_get_as_i64_d968e41184ae354f: function (arg0, arg1) {
      const v = arg1;
      const ret = typeof v === "bigint" ? v : undefined;
      getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
      getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
    },
    __wbg___wbindgen_boolean_get_fa956cfa2d1bd751: function (arg0) {
      const v = arg0;
      const ret = typeof v === "boolean" ? v : undefined;
      return isLikeNone(ret) ? 0xffffff : ret ? 1 : 0;
    },
    __wbg___wbindgen_copy_to_typed_array_4db0cbe2cc60dbee: function (arg0, arg1, arg2) {
      new Uint8Array(arg2.buffer, arg2.byteOffset, arg2.byteLength).set(
        getArrayU8FromWasm0(arg0, arg1),
      );
    },
    __wbg___wbindgen_debug_string_c25d447a39f5578f: function (arg0, arg1) {
      const ret = debugString(arg1);
      const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len1 = WASM_VECTOR_LEN;
      getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
      getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    },
    __wbg___wbindgen_in_aca499c5de7ff5e5: function (arg0, arg1) {
      const ret = arg0 in arg1;
      return ret;
    },
    __wbg___wbindgen_is_bigint_2f76dc55065b4273: function (arg0) {
      const ret = typeof arg0 === "bigint";
      return ret;
    },
    __wbg___wbindgen_is_function_1ff95bcc5517c252: function (arg0) {
      const ret = typeof arg0 === "function";
      return ret;
    },
    __wbg___wbindgen_is_object_a27215656b807791: function (arg0) {
      const val = arg0;
      const ret = typeof val === "object" && val !== null;
      return ret;
    },
    __wbg___wbindgen_is_undefined_c05833b95a3cf397: function (arg0) {
      const ret = arg0 === undefined;
      return ret;
    },
    __wbg___wbindgen_jsval_eq_e659fcf7b0e32763: function (arg0, arg1) {
      const ret = arg0 === arg1;
      return ret;
    },
    __wbg___wbindgen_jsval_loose_eq_db4c3b15f63fc170: function (arg0, arg1) {
      const ret = arg0 == arg1;
      return ret;
    },
    __wbg___wbindgen_number_get_394265ed1e1b84ee: function (arg0, arg1) {
      const obj = arg1;
      const ret = typeof obj === "number" ? obj : undefined;
      getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
      getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
    },
    __wbg___wbindgen_string_get_b0ca35b86a603356: function (arg0, arg1) {
      const obj = arg1;
      const ret = typeof obj === "string" ? obj : undefined;
      var ptr1 = isLikeNone(ret)
        ? 0
        : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      var len1 = WASM_VECTOR_LEN;
      getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
      getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    },
    __wbg___wbindgen_throw_344f42d3211c4765: function (arg0, arg1) {
      throw new Error(getStringFromWasm0(arg0, arg1));
    },
    __wbg_call_8a2dd23819f8a60a: function () {
      return handleError(function (arg0, arg1) {
        const ret = arg0.call(arg1);
        return ret;
      }, arguments);
    },
    __wbg_done_89b2b13e91a60321: function (arg0) {
      const ret = arg0.done;
      return ret;
    },
    __wbg_entries_015dc610cd81ede0: function (arg0) {
      const ret = Object.entries(arg0);
      return ret;
    },
    __wbg_get_507a50627bffa49b: function (arg0, arg1) {
      const ret = arg0[arg1 >>> 0];
      return ret;
    },
    __wbg_get_c7eb1f358a7654df: function () {
      return handleError(function (arg0, arg1) {
        const ret = Reflect.get(arg0, arg1);
        return ret;
      }, arguments);
    },
    __wbg_get_unchecked_6e0ad6d2a41b06f6: function (arg0, arg1) {
      const ret = arg0[arg1 >>> 0];
      return ret;
    },
    __wbg_get_with_ref_key_6412cf3094599694: function (arg0, arg1) {
      const ret = arg0[arg1];
      return ret;
    },
    __wbg_instanceof_ArrayBuffer_4480b9e0068a8adb: function (arg0) {
      let result;
      try {
        result = arg0 instanceof ArrayBuffer;
      } catch (_) {
        result = false;
      }
      const ret = result;
      return ret;
    },
    __wbg_instanceof_Map_e5b5e3db98422fcc: function (arg0) {
      let result;
      try {
        result = arg0 instanceof Map;
      } catch (_) {
        result = false;
      }
      const ret = result;
      return ret;
    },
    __wbg_instanceof_Uint8Array_309b927aaf7a3fc7: function (arg0) {
      let result;
      try {
        result = arg0 instanceof Uint8Array;
      } catch (_) {
        result = false;
      }
      const ret = result;
      return ret;
    },
    __wbg_isArray_0677c962b281d01a: function (arg0) {
      const ret = Array.isArray(arg0);
      return ret;
    },
    __wbg_isSafeInteger_04f36e4056f1b851: function (arg0) {
      const ret = Number.isSafeInteger(arg0);
      return ret;
    },
    __wbg_iterator_6f722e4a93058b71: function () {
      const ret = Symbol.iterator;
      return ret;
    },
    __wbg_length_1f0964f4a5e2c6d8: function (arg0) {
      const ret = arg0.length;
      return ret;
    },
    __wbg_length_370319915dc99107: function (arg0) {
      const ret = arg0.length;
      return ret;
    },
    __wbg_new_32b398fb48b6d94a: function () {
      const ret = new Array();
      return ret;
    },
    __wbg_new_cd45aabdf6073e84: function (arg0) {
      const ret = new Uint8Array(arg0);
      return ret;
    },
    __wbg_new_da52cf8fe3429cb2: function () {
      const ret = new Object();
      return ret;
    },
    __wbg_next_6dbf2c0ac8cde20f: function (arg0) {
      const ret = arg0.next;
      return ret;
    },
    __wbg_next_71f2aa1cb3d1e37e: function () {
      return handleError(function (arg0) {
        const ret = arg0.next();
        return ret;
      }, arguments);
    },
    __wbg_prototypesetcall_4770620bbe4688a0: function (arg0, arg1, arg2) {
      Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
    },
    __wbg_set_6be42768c690e380: function (arg0, arg1, arg2) {
      arg0[arg1] = arg2;
    },
    __wbg_set_8a16b38e4805b298: function (arg0, arg1, arg2) {
      arg0[arg1 >>> 0] = arg2;
    },
    __wbg_value_a5d5488a9589444a: function (arg0) {
      const ret = arg0.value;
      return ret;
    },
    __wbindgen_cast_0000000000000001: function (arg0) {
      // Cast intrinsic for `F64 -> Externref`.
      const ret = arg0;
      return ret;
    },
    __wbindgen_cast_0000000000000002: function (arg0) {
      // Cast intrinsic for `I64 -> Externref`.
      const ret = arg0;
      return ret;
    },
    __wbindgen_cast_0000000000000003: function (arg0, arg1) {
      // Cast intrinsic for `Ref(String) -> Externref`.
      const ret = getStringFromWasm0(arg0, arg1);
      return ret;
    },
    __wbindgen_cast_0000000000000004: function (arg0) {
      // Cast intrinsic for `U64 -> Externref`.
      const ret = BigInt.asUintN(64, arg0);
      return ret;
    },
    __wbindgen_init_externref_table: function () {
      const table = wasm.__wbindgen_externrefs;
      const offset = table.grow(4);
      table.set(0, undefined);
      table.set(offset + 0, undefined);
      table.set(offset + 1, null);
      table.set(offset + 2, true);
      table.set(offset + 3, false);
    },
  };
  return {
    __proto__: null,
    "./imgdiff_wasm_bg.js": import0,
  };
}

const CompareScoresFinalization =
  typeof FinalizationRegistry === "undefined"
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry((ptr) => wasm.__wbg_comparescores_free(ptr, 1));

function addToExternrefTable0(obj) {
  const idx = wasm.__externref_table_alloc();
  wasm.__wbindgen_externrefs.set(idx, obj);
  return idx;
}

function debugString(val) {
  // primitive types
  const type = typeof val;
  if (type == "number" || type == "boolean" || val == null) {
    return `${val}`;
  }
  if (type == "string") {
    return `"${val}"`;
  }
  if (type == "symbol") {
    const description = val.description;
    if (description == null) {
      return "Symbol";
    } else {
      return `Symbol(${description})`;
    }
  }
  if (type == "function") {
    const name = val.name;
    if (typeof name == "string" && name.length > 0) {
      return `Function(${name})`;
    } else {
      return "Function";
    }
  }
  // objects
  if (Array.isArray(val)) {
    const length = val.length;
    let debug = "[";
    if (length > 0) {
      debug += debugString(val[0]);
    }
    for (let i = 1; i < length; i++) {
      debug += ", " + debugString(val[i]);
    }
    debug += "]";
    return debug;
  }
  // Test for built-in
  const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
  let className;
  if (builtInMatches && builtInMatches.length > 1) {
    className = builtInMatches[1];
  } else {
    // Failed to match the standard '[object ClassName]'
    return toString.call(val);
  }
  if (className == "Object") {
    // we're a user defined class or Object
    // JSON.stringify avoids problems with cycles, and is generally much
    // easier than looping through ownProperties of `val`.
    try {
      return "Object(" + JSON.stringify(val) + ")";
    } catch (_) {
      return "Object";
    }
  }
  // errors
  if (val instanceof Error) {
    return `${val.name}: ${val.message}\n${val.stack}`;
  }
  // TODO we could test for more things here, like `Set`s and `Map`s.
  return className;
}

function getArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
  if (
    cachedDataViewMemory0 === null ||
    cachedDataViewMemory0.buffer.detached === true ||
    (cachedDataViewMemory0.buffer.detached === undefined &&
      cachedDataViewMemory0.buffer !== wasm.memory.buffer)
  ) {
    cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
  }
  return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
  return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
  try {
    return f.apply(this, args);
  } catch (e) {
    const idx = addToExternrefTable0(e);
    wasm.__wbindgen_exn_store(idx);
  }
}

function isLikeNone(x) {
  return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 1, 1) >>> 0;
  getUint8ArrayMemory0().set(arg, ptr / 1);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === undefined) {
    const buf = cachedTextEncoder.encode(arg);
    const ptr = malloc(buf.length, 1) >>> 0;
    getUint8ArrayMemory0()
      .subarray(ptr, ptr + buf.length)
      .set(buf);
    WASM_VECTOR_LEN = buf.length;
    return ptr;
  }

  let len = arg.length;
  let ptr = malloc(len, 1) >>> 0;

  const mem = getUint8ArrayMemory0();

  let offset = 0;

  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 0x7f) break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    if (offset !== 0) {
      arg = arg.slice(offset);
    }
    ptr = realloc(ptr, len, (len = offset + arg.length * 3), 1) >>> 0;
    const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
    const ret = cachedTextEncoder.encodeInto(arg, view);

    offset += ret.written;
    ptr = realloc(ptr, len, offset, 1) >>> 0;
  }

  WASM_VECTOR_LEN = offset;
  return ptr;
}

function takeFromExternrefTable0(idx) {
  const value = wasm.__wbindgen_externrefs.get(idx);
  wasm.__externref_table_dealloc(idx);
  return value;
}

let cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
  numBytesDecoded += len;
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
    cachedTextDecoder.decode();
    numBytesDecoded = len;
  }
  return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!("encodeInto" in cachedTextEncoder)) {
  cachedTextEncoder.encodeInto = function (arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
      read: arg.length,
      written: buf.length,
    };
  };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
  wasmInstance = instance;
  wasm = instance.exports;
  wasmModule = module;
  cachedDataViewMemory0 = null;
  cachedUint8ArrayMemory0 = null;
  wasm.__wbindgen_start();
  return wasm;
}

async function __wbg_load(module, imports) {
  if (typeof Response === "function" && module instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(module, imports);
      } catch (e) {
        const validResponse = module.ok && expectedResponseType(module.type);

        if (validResponse && module.headers.get("Content-Type") !== "application/wasm") {
          console.warn(
            "`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n",
            e,
          );
        } else {
          throw e;
        }
      }
    }

    const bytes = await module.arrayBuffer();
    return await WebAssembly.instantiate(bytes, imports);
  } else {
    const instance = await WebAssembly.instantiate(module, imports);

    if (instance instanceof WebAssembly.Instance) {
      return { instance, module };
    } else {
      return instance;
    }
  }

  function expectedResponseType(type) {
    switch (type) {
      case "basic":
      case "cors":
      case "default":
        return true;
    }
    return false;
  }
}

function initSync(module) {
  if (wasm !== undefined) return wasm;

  if (module !== undefined) {
    if (Object.getPrototypeOf(module) === Object.prototype) {
      ({ module } = module);
    } else {
      console.warn("using deprecated parameters for `initSync()`; pass a single object instead");
    }
  }

  const imports = __wbg_get_imports();
  if (!(module instanceof WebAssembly.Module)) {
    module = new WebAssembly.Module(module);
  }
  const instance = new WebAssembly.Instance(module, imports);
  return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
  if (wasm !== undefined) return wasm;

  if (module_or_path !== undefined) {
    if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
      ({ module_or_path } = module_or_path);
    } else {
      console.warn(
        "using deprecated parameters for the initialization function; pass a single object instead",
      );
    }
  }

  if (module_or_path === undefined) {
    module_or_path = new URL("imgdiff_wasm_bg.wasm", import.meta.url);
  }
  const imports = __wbg_get_imports();

  if (
    typeof module_or_path === "string" ||
    (typeof Request === "function" && module_or_path instanceof Request) ||
    (typeof URL === "function" && module_or_path instanceof URL)
  ) {
    module_or_path = fetch(module_or_path);
  }

  const { instance, module } = await __wbg_load(await module_or_path, imports);

  return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
