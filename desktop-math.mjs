import { expLead, expTail, logInverse, logLead, logTail } from './desktop-math-tables.mjs';

// Adapted from amd/win-libm log10.asm and pow.asm (MIT).
// See desktop-math-tables.mjs for the copyright and license notice.
// Match the FMA3 path of the Windows Python baseline in any JS runtime.
const buffer = new DataView(new ArrayBuffer(8));
const fractionMask = (1n << 52n) - 1n;
const hiddenBit = 1n << 52n;
const signBit = 1n << 63n;

function bits(value) {
    buffer.setFloat64(0, value);
    return buffer.getBigUint64(0);
}

function fromBits(value) {
    buffer.setBigUint64(0, value);
    return buffer.getFloat64(0);
}

function decompose(value) {
    const binary = bits(value);
    const biasedExponent = Number((binary >> 52n) & 2047n);
    const fraction = (binary & fractionMask) | (biasedExponent ? hiddenBit : 0n);
    return [binary & signBit ? -fraction : fraction, Math.max(biasedExponent, 1) - 1075];
}

// Round a signed integer times a power of two once, to binary64.
function roundBinary(value, exponent) {
    if (value === 0n) return 0;
    const negative = value < 0n;
    let magnitude = negative ? -value : value;
    const discard = Math.max(magnitude.toString(2).length - 53, -1074 - exponent);
    if (discard > 0) {
        const shift = BigInt(discard);
        const half = 1n << (shift - 1n);
        const high = magnitude >> shift;
        const remainder = magnitude - (high << shift);
        magnitude = high + (remainder > half || (remainder === half && (high & 1n)) ? 1n : 0n);
        exponent += discard;
    }
    const rounded = Number(magnitude) * 2 ** exponent;
    return negative ? -rounded : rounded;
}

function fma(a, b, c) {
    if (a === 0 || b === 0) return a * b + c;
    const [x, xExp] = decompose(a);
    const [y, yExp] = decompose(b);
    const [z, zExp] = decompose(c);
    const productExp = xExp + yExp;
    if (z === 0n) return roundBinary(x * y, productExp);
    const exponent = Math.min(productExp, zExp);
    const product = (x * y) << BigInt(productExp - exponent);
    const addend = z << BigInt(zExp - exponent);
    return roundBinary(product + addend, exponent);
}

function log10NearOne(x) {
    const r = x - 1;
    const half = r / (2 + r);
    const u = half + half;
    const u2 = u * u;
    const u3 = u2 * u;
    const u7 = (u3 * u3) * u;
    const lowOrder = fma(fromBits(0x3f89999999bac6d4n), u2, fromBits(0x3fb55555555554e6n)) * u3;
    const highOrder = fma(fromBits(0x3f3c8034c85dfff0n), u2, fromBits(0x3f62492307f1519fn)) * u7;
    const high = fromBits(bits(r) & 0xffffffff00000000n);
    const low = (lowOrder + highOrder - r * half) + (r - high);
    const lead = fromBits(0x3fdbcb7800000000n);
    const tail = fromBits(0x3ea8a93728719535n);
    return ((high * tail + low * tail) + low * lead) + high * lead;
}

function log10(x) {
    if (x === 0) return -Infinity;
    if (x < 0 || Number.isNaN(x)) return NaN;
    if (x === Infinity) return x;
    if (Math.abs(x - 1) < 0.0625) return log10NearOne(x);
    const subnormal = x < 2 ** -1022;
    const binary = bits(subnormal ? x * 2 ** 52 : x);
    const fraction = binary & fractionMask;
    const index = Number((fraction + (1n << 43n)) >> 44n);
    const exponent = Number(binary >> 52n) - 1023 - (subnormal ? 52 : 0);
    const y = fromBits(0x3fe0000000000000n | fraction);
    const closest = fromBits(0x3fe0000000000000n | (BigInt(index) << 44n));
    const r = (closest - y) * logInverse[index];
    const r2 = r * r;
    const highOrder = fma(fma(1 / 6, r, 1 / 5), r, 1 / 4);
    const polynomial = fma(highOrder, r2 * r2, fma(fma(1 / 3, r, 0.5), r2, r));
    const correction = fma(fromBits(0x3e03ef3fde623e25n), exponent,
        -polynomial * fromBits(0x3fdbcb7b1526e50en));
    return fma(exponent, fromBits(0x3fd3441350000000n), logLead[index])
        + (logTail[index] + correction);
}

function pow10(y) {
    if (Number.isNaN(y)) return NaN;
    if (y > 309) return Infinity;
    if (y < -324) return 0;
    // Head and tail from the reference log calculation specialized to base 10.
    const ln10High = fromBits(0x40026bb1b8000000n);
    const ln10Low = fromBits(0x3e5daaa8ac16ea50n);
    const yHigh = fromBits(bits(y) & 0xfffffffff8000000n);
    const yLow = y - yHigh;
    const high = yHigh * ln10High;
    const low = (yLow * ln10Low + yLow * ln10High) + yHigh * ln10Low;
    const product = high + low;
    const correction = (high - product) + low;
    const scaled = product * fromBits(0x40571547652b82fen);
    if (scaled > 65536) return Infinity;
    if (scaled < -68800) return 0;
    const floor = Math.floor(scaled);
    const n = scaled - floor === 0.5 ? floor + (floor & 1) : Math.round(scaled);
    const index = n & 63;
    const exponent = (n - index) / 64;
    const r = (fma(-n, fromBits(0x3f862e42f0000000n), product)
        + n * fromBits(0xbdfdf473de6af278n)) + correction;
    let polynomial = 1 / 720;
    for (const coefficient of [1 / 120, 1 / 24, 1 / 6, 0.5, 1]) {
        polynomial = fma(polynomial, r, coefficient);
    }
    const q = polynomial * r;
    const z = (q * expLead[index] + (q * expTail[index] + expTail[index])) + expLead[index];
    if (exponent === 1024) {
        return z >= 1 ? Infinity : fromBits(bits(z) | 0x7fe0000000000000n);
    }
    if (exponent === -1075) return Number.MIN_VALUE;
    return z * 2 ** exponent;
}

export function toSPL(dbv) {
    return 20 * log10(pow10(dbv / 20) / 0.05) + 93.9;
}
