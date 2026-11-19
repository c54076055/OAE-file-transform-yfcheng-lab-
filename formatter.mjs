const parameters = ['AudFreq()', 'F1(hz)', 'V1(dBv)', 'F2(hz)', 'V2(dBv)', 'F3(hz)', 'V3(dBv)'];
const levels = ['85_75', '75_65', '65_55', '55_45', '45_35', '35_25', '25_15'];
const thresholds = ['75+', 75, 65, 55, 45, 35, 25, 15];

function readCSV(text) {
    text = text.replace(/^\uFEFF/, '');
    const field = /(?:"((?:[^"]|"")*)"|([^",\r\n]*))([,\r\n]|$)/y;
    const rows = [];
    let row = [];
    while (field.lastIndex < text.length) {
        const match = field.exec(text);
        if (!match) throw new Error('CSV 引號或分隔符號有誤。');
        row.push(match[1]?.replace(/""/g, '"') ?? match[2]);
        if (match[3] === ',') continue;
        if (match[3] === '\r' && text[field.lastIndex] === '\n') field.lastIndex++;
        if (row.length > 1 || row[0].trim()) rows.push(row);
        row = [];
    }
    if (row.length) rows.push([...row, '']);
    return rows;
}

export function readMeasurement(text) {
    const [header = [], ...rows] = readCSV(text);
    const missing = parameters.filter(name => !header.includes(name));
    if (missing.length) throw new Error(`缺少欄位 ${missing.join('、')}。`);
    if (rows.length !== levels.length || rows.some(row => row.length !== header.length)) {
        throw new Error('需要 7 列量測資料，且每列欄位數須與標題列相同。');
    }
    const v3 = rows.map(row => row[header.indexOf('V3(dBv)')]);
    const bins = header.slice(13);
    const numeric = value => value.trim() !== '' && Number.isFinite(Number(value));
    if (!v3.every(numeric)) throw new Error('V3(dBv) 欄位含有無效數值。');
    const peak = bins.findIndex((bin, index) => /^\d+$/.test(bin) && numeric(rows[0][index + 13])
        && Number(rows[0][index + 13]) === Number(v3[0]));
    if (peak === -1) throw new Error('頻譜中找不到第一列 V3(dBv) 對應的頻譜欄。');
    const binNumber = Number(bins[peak]);
    const neighbors = bins.flatMap((bin, index) =>
        /^\d+$/.test(bin) && index !== peak && Math.abs(Number(bin) - binNumber) <= 10 ? [index + 13] : []);
    const noise = rows.map(row => neighbors.map(index => row[index]));
    if (!neighbors.length || !noise.every(row => row.every(numeric))) {
        throw new Error('相鄰頻譜欄缺少有效的雜訊數值。');
    }
    return { v3: v3.map(Number), noise: noise.map(row => row.map(Number)) };
}

export function inferMetadata(name) {
    const stem = name.replace(/\.csv$/i, '');
    const frequency = Number(stem.match(/(\d+(?:\.\d+)?)k(?=[_\s-]|$)/i)?.[1]);
    const ear = stem.match(/(?:^|[_\s-])([LR])(?=$|[_\s-])/i)?.[1].toUpperCase()
        ?? stem.match(/([LR])$/)?.[1] ?? '';
    const title = stem.replace(/[\s_-]*\d+(?:\.\d+)?k[_\s-]*[LR]$/i, '').trim();
    return { ear, frequency: frequency > 0 ? String(frequency) : '', title };
}

const toSPL = dbv => 20 * Math.log10(10 ** (dbv / 20) / 0.05) + 93.9;

function statistics(values) {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return [mean, Math.sqrt(variance)];
}

function analyze({ measurement, frequency, name }, coefficient) {
    const dbv = [];
    const spl = [];
    for (const [index, level] of levels.entries()) {
        const noise = measurement.noise[index];
        const [mean, sd] = statistics(noise.map(toSPL));
        const signal = toSPL(measurement.v3[index]);
        const limit = mean + coefficient * sd;
        const dbvStats = statistics(noise);
        if (![signal, limit, ...dbvStats].every(Number.isFinite)) {
            throw new Error(`${name} 的數值超出計算範圍。`);
        }
        dbv.push([level, measurement.v3[index], ...dbvStats]);
        spl.push([level, signal, mean, sd, signal > limit ? 'pass' : 'fail']);
    }
    const passes = spl.filter(row => row[4] === 'pass').length;
    const label = `${Number(frequency)}k`;
    return {
        dbv: [[label, 'dBv', 'NF', 'NF_SD'], ...dbv],
        spl: [[label, 'dB SPL', 'NF(dB SPL)', 'NF_SD', 'Threshold'], ...spl],
        summary: [label, thresholds[passes], passes ? spl[passes - 1][2] : 'NA'],
    };
}

export function calculateRows(files, coefficient) {
    const count = Math.max(9, ...['L', 'R'].map(ear => files.filter(file => file.ear === ear).length + 1));
    const rows = ['L', 'R'].flatMap(ear => {
        const results = files.filter(file => file.ear === ear)
            .sort((a, b) => Number(a.frequency) - Number(b.frequency))
            .map(file => analyze(file, coefficient));
        const summary = [['  ', 'Threshold', 'NF'], ...results.map(result => result.summary)];
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
    return rows.map(row => [...row, ...Array(width - row.length).fill(' ')]);
}

export function encodeCSV(rows) {
    return rows.map(row => row.map(value => {
        const cell = String(value);
        return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
    }).join(',')).join('\r\n');
}

export function downloadName(title) {
    const stem = title.trim().replace(/\.csv$/i, '')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
    const reserved = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
    return `${reserved.test(stem) ? '_' : ''}${Array.from(stem).slice(0, 120).join('') || 'output'}.csv`;
}
