import { toSPL } from './desktop-math.mjs';

const parameters = ['AudFreq()', 'F1(hz)', 'V1(dBv)', 'F2(hz)', 'V2(dBv)', 'F3(hz)', 'V3(dBv)'];
const levels = ['85_75', '75_65', '65_55', '55_45', '45_35', '35_25', '25_15'];
const thresholds = [75, 65, 55, 45, 35, 25, 15];

export function readCSV(text, lineNumbers = []) {
    text = text.replace(/^\uFEFF/, '');
    const field = /(?:"((?:[^"]|"")*)"|([^",\r\n]*))([,\r\n]|$)/y;
    const rows = [];
    let row = [];
    let line = 1;
    let start = 1;
    while (field.lastIndex < text.length) {
        const match = field.exec(text);
        if (!match) throw new Error('CSV 引號或分隔符號有誤。');
        row.push(match[1]?.replace(/""/g, '"') ?? match[2]);
        line += (match[1]?.match(/\r\n|\r|\n/g) ?? []).length;
        if (match[3] === ',') continue;
        if (match[3] === '\r' && text[field.lastIndex] === '\n') field.lastIndex++;
        if (row.length > 1 || row[0].trim()) {
            rows.push(row);
            lineNumbers.push(start);
        }
        if (match[3]) line++;
        start = line;
        row = [];
    }
    if (row.length) {
        rows.push([...row, '']);
        lineNumbers.push(start);
    }
    return rows;
}

// pandas 2.0.3 defaults to its 17-digit float converter for decimal CSV columns.
const decimal = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i;
const missingNumber = /^(?:|#N\/A(?: N\/A)?|#NA|-?1\.#(?:IND|QNAN)|-?NaN|<NA>|N\/A|NA|NULL|None|n\/a|nan|null)$/;

export function parseColumn(cells) {
    const integer = cells.every(cell => /^[+-]?\d+$/.test(cell.trim()));
    return cells.map(cell => {
        const text = cell.trim();
        if (missingNumber.test(cell)) return NaN;
        if (/^[+-]?inf(?:inity)?$/i.test(text)) return text[0] === '-' ? -Infinity : Infinity;
        const match = decimal.exec(text);
        if (!match || !(match[2] || match[3])) return cell;
        if (integer) return Number(text);
        const [, sign, whole, fractional = '', exponent] = match;
        const digits = (whole + fractional).slice(0, 17);
        const scale = Number(exponent ?? 0) + whole.length - digits.length;
        let value = 0;
        for (const digit of digits) value = value * 10 + Number(digit);
        if (sign === '-') value = -value;
        if (scale > 308) return cell;
        if (scale >= 0) return value * Number(`1e${scale}`);
        if (scale >= -308) return value / Number(`1e${-scale}`);
        if (scale < -616) return value * 0;
        return (value / Number(`1e${-scale - 308}`)) / 1e308;
    });
}

export function readMeasurement(text) {
    const [header = [], ...rows] = readCSV(text);
    const missing = parameters.filter(name => !header.includes(name));
    if (missing.length) throw new Error(`缺少欄位 ${missing.join('、')}。`);
    if (rows.length !== levels.length || rows.some(row => row.length !== header.length)) {
        throw new Error('需要 7 列量測資料，且每列欄位數須與標題列相同。');
    }
    const valueColumn = index => parseColumn(rows.map(row => row[index]));
    const v3 = valueColumn(header.indexOf('V3(dBv)'));
    const bins = header.slice(13);
    if (v3.some(value => typeof value !== 'number')) throw new Error('V3(dBv) 欄位含有無效數值。');
    const spectrum = bins.map((_, index) => valueColumn(index + 13));
    const peak = spectrum.findIndex(column => column.every((value, index) => value === v3[index]));
    if (peak === -1) throw new Error('頻譜中找不到與完整 V3(dBv) 序列相符的欄位。');
    const binNumber = Number(bins[peak]);
    if (!/^[-+]?\d+$/.test(bins[peak]) || !bins.includes(String(binNumber))) {
        throw new Error('訊號欄的名稱須能對應整數欄號。');
    }
    const columns = spectrum.filter((_, index) => bins[index] !== String(binNumber));
    const neighbors = columns.slice(binNumber - 10, binNumber + 10);
    if (neighbors.some(column => column.some(value => typeof value !== 'number'))) {
        throw new Error('相鄰頻譜欄含有無效數值。');
    }
    return { v3, noise: rows.map((_, index) => neighbors.map(column => column[index])) };
}

export function inferMetadata(name) {
    const stem = name.replace(/\.csv$/i, '');
    const frequency = Number(stem.match(/(\d+(?:\.\d+)?)k(?=[_\s-]|$)/i)?.[1]);
    const ear = stem.match(/(?:^|[_\s-])([LR])(?=$|[_\s-])/i)?.[1].toUpperCase()
        ?? stem.match(/([LR])$/)?.[1] ?? '';
    const title = stem.replace(/[\s_-]*\d+(?:\.\d+)?k[_\s-]*[LR]$/i, '').trim();
    return { ear, frequency: frequency > 0 ? String(frequency) : '', title };
}

function statistics(values) {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => {
        const delta = value - mean;
        return sum + delta * delta;
    }, 0) / values.length;
    return [mean, Math.sqrt(variance)];
}

function pythonFloat(value) {
    if (Number.isNaN(value)) return ' ';
    if (!Number.isFinite(value)) return value < 0 ? '-inf' : 'inf';
    if (Object.is(value, -0)) return '-0.0';
    const magnitude = Math.abs(value);
    if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e16)) {
        return value.toExponential().replace(/e([+-])(\d)$/, 'e$10$2');
    }
    return Number.isInteger(value) ? `${value}.0` : String(value);
}

function analyze({ measurement, frequency, label, report = () => {} }, coefficient) {
    const dbv = [];
    const spl = [];
    for (const [index, level] of levels.entries()) {
        const noise = measurement.noise[index];
        const [mean, sd] = statistics(noise.map(toSPL));
        const signal = toSPL(measurement.v3[index]);
        const limit = mean + coefficient * sd;
        const dbvStats = statistics(noise);
        if (![measurement.v3[index], ...noise, signal, mean, sd, limit, ...dbvStats].every(Number.isFinite)
            || noise.length === 0) {
            if (noise.length) report(index, '訊號、雜訊視窗或計算結果含無效數值。');
            dbv.push([level, 'NA', 'NA', 'NA']);
            spl.push([level, 'NA', 'NA', 'NA', '無法判定']);
            continue;
        }
        dbv.push([level, ...[measurement.v3[index], ...dbvStats].map(pythonFloat)]);
        spl.push([level, ...[signal, mean, sd].map(pythonFloat), signal > limit ? 'pass' : 'fail']);
    }
    const firstNonPass = spl.findIndex(row => row[4] !== 'pass');
    const passes = firstNonPass === -1 ? spl.length : firstNonPass;
    const allFail = spl.every(row => row[4] === 'fail');
    const needsReview = passes === 0 && spl.some(row => row[4] === 'pass');
    const hasThreshold = passes > 0 && spl[passes]?.[4] !== '無法判定';
    const frequencyLabel = label ?? `${Number(frequency)}k`;
    const threshold = hasThreshold ? pythonFloat(thresholds[passes - 1]) : (allFail ? '75+' : 'NA');
    const review = needsReview && spl[0][4] === 'fail';
    if (review) report(null, '最高級別未通過，較低級別有通過結果，待複核。');
    if (threshold === 'NA' && !review) report(null, '資料不足，無法確定摘要門檻。');
    return {
        dbv: [[frequencyLabel, 'dBv', 'NF', 'NF_SD'], ...dbv],
        spl: [[frequencyLabel, 'dB SPL', 'NF(dB SPL)', 'NF_SD', 'Threshold'], ...spl],
        summary: [frequencyLabel, threshold, hasThreshold ? spl[passes - 1][2] : 'NA'],
        needsReview: review,
    };
}

export function calculateRows(files, coefficient) {
    return calculateResult(files, coefficient).rows;
}

export function calculateResult(files, coefficient) {
    const count = Math.max(9, ...['L', 'R'].map(ear => files.filter(file => file.ear === ear).length + 1));
    const reviews = [];
    const rows = ['L', 'R'].flatMap(ear => {
        const results = files.filter(file => file.ear === ear)
            .sort((a, b) => Number(a.frequency) - Number(b.frequency))
            .map(file => analyze(file, coefficient));
        const summary = [['  ', 'Threshold', 'NF'], ...results.map(result => result.summary)];
        for (const result of results) {
            if (result.needsReview) reviews.push({ ear, frequencyLabel: result.summary[0] });
        }
        return Array.from({ length: count + 1 }, (_, index) => [
            index === 0 ? ear : ' ',
            ...results.flatMap(result => result.dbv[index] ?? Array(4).fill(' ')),
            index === 0 ? ear : ' ',
            ...results.flatMap(result => result.spl[index] ?? Array(5).fill(' ')),
            index === 0 ? ear : ' ',
            ...(summary[index] ?? Array(3).fill(' ')),
        ]);
    });
    const width = Math.max(...rows.map(row => row.length));
    return {
        rows: rows.map(row => [...row, ...Array(width - row.length).fill(' ')]),
        reviews,
    };
}

export function encodeCSV(rows) {
    return rows.map(row => row.map(value => {
        const cell = String(value);
        return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
    }).join(',')).join('\r\n') + '\r\n';
}

export function downloadName(title) {
    return title.trim() ? `${title}_output.csv` : 'output.csv';
}
