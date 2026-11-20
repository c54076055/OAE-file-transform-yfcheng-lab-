import { calculateResult, parseColumn, readCSV } from './formatter.mjs';

const levels = ['85_75', '75_65', '65_55', '55_45', '45_35', '35_25', '25_15'];
const tones = ['F1(hz)', 'F2(hz)', 'F3(hz)'];
const required = ['AudFreq()', 'V3(dBv)', 'V1(dBv)', ...tones];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function inspectMeasurement(content) {
    const lines = [];
    const [header = [], ...raw] = readCSV(content, lines);
    for (const name of required) {
        if (header.filter(cell => cell === name).length !== 1) {
            throw new Error(`必要欄位 ${name} 缺失或重複。`);
        }
    }
    const bins = header.slice(13);
    while (bins.length && !bins.at(-1).trim()) bins.pop();
    if (!bins.length || bins.some((bin, index) => bin !== String(index))) {
        throw new Error('頻譜欄號必須從 0 開始且連續。');
    }
    const rows = raw.map((cells, index) => ({
        cells, line: lines[index + 1], valid: cells.length === header.length,
    }));
    const column = name => {
        const index = header.indexOf(name);
        return parseColumn(rows.map(row => row.valid ? row.cells[index] ?? '' : ''));
    };
    const frequencies = column('AudFreq()');
    const distinct = [...new Set(frequencies.filter(value => Number.isFinite(value) && value > 0))];
    const frequency = distinct.length === 1 ? distinct[0] / 1000 : null;
    return { header, bins, rows, column, frequencies, frequency, distinct, records: column('Rec No.') };
}

function align(data, report) {
    const { rows, header, column } = data;
    const positions = Array(levels.length).fill(null);
    const levelIndex = header.indexOf('Level()');
    const explicit = rows.map(row => levels.indexOf(row.cells[levelIndex]?.trim()));
    if (explicit.some(index => index >= 0)) {
        for (const [index, level] of levels.entries()) {
            const matches = rows.filter((_, rowIndex) => explicit[rowIndex] === index);
            if (matches.length === 1) positions[index] = rows.indexOf(matches[0]);
            else report(matches[0]?.line, level, matches.length ? '刺激級別重複。' : '刺激級別缺漏。');
        }
        rows.forEach((row, index) => {
            if (explicit[index] < 0) report(row.line, '', '無法辨識刺激級別。');
        });
        return positions;
    }

    const records = column('Rec No.');
    const sequence = records.map((record, index) => ({ record, index }))
        .sort((a, b) => a.record - b.record);
    const recognized = header[0] === 'Rec No.' && header[2] === 'Level()' && header[12] === 'Data(v)...'
        && rows.every(row => Number(row.cells[levelIndex]) === 0 && row.cells[levelIndex]?.trim());
    if (!recognized || sequence.length !== levels.length
        || sequence.some(({ record }, index) => !Number.isSafeInteger(record)
            || record !== sequence[0].record + index)) {
        report(null, '', '無法由刺激級別或完整的 Rec No. 序列確認順序。');
        return positions;
    }
    const v1 = column('V1(dBv)');
    const validV1 = sequence.map(({ index }) => v1[index]).filter(Number.isFinite);
    if (validV1.some((value, index) => index > 0 && value >= validV1[index - 1])) {
        report(null, '', 'V1(dBv) 與 Rec No. 的刺激級別順序矛盾。');
        return positions;
    }
    if (validV1.length !== levels.length) report(null, '', '部分 V1(dBv) 無效，無法完成順序複核。', '提示');
    return sequence.map(({ index }) => index);
}

function prepare(file, report, conflicts) {
    const { data } = file;
    const positions = align(data, report);
    if (positions.every(index => index === null)) return null;
    const { rows, bins, column, frequencies } = data;
    const v3 = column('V3(dBv)');
    const eligible = positions.filter(index => index !== null && rows[index].valid && !conflicts?.has(index)
        && Number.isFinite(frequencies[index]) && frequencies[index] > 0
        && (data.distinct.length === 1 || frequencies[index] / 1000 === Number(file.frequency)));
    const evidence = eligible.filter(index => Number.isFinite(v3[index]));
    const spectrum = bins.map(column);
    const matches = spectrum.flatMap((values, bin) => evidence.length
        && evidence.every(index => values[index] === v3[index]) ? [bin] : []);
    const signal = matches[0];
    if (matches.length !== 1) {
        report(null, '', matches.length ? '有多個頻譜欄符合 V3(dBv)。' : '找不到符合本檔 V3(dBv) 的訊號欄。');
        return null;
    }
    const noise = spectrum.filter((_, bin) => bin !== signal).slice(Math.max(0, signal - 10), signal + 10);
    if (signal < 10 || noise.length !== 20) {
        report(null, '', '訊號欄相鄰的雜訊視窗不足 20 欄。');
        return null;
    }
    return {
        signal,
        settings: JSON.stringify([data.header, ...tones.map(column)]),
        v3: positions.map(index => v3[index]),
        noise: positions.map((index, level) => {
            if (index === null) return [];
            if (eligible.includes(index)) return noise.map(values => values[index]);
            report(rows[index].line, levels[level], conflicts?.has(index)
                ? '同批次的 Rec No. 有衝突。' : '列欄數或 AudFreq() 無效，或該列頻率未確認。');
            return [];
        }),
        positions,
    };
}

export function validateBatch(files, coefficient) {
    const valid = [];
    const issues = [];
    const groups = new Map();
    const ordered = files.slice().sort((a, b) => compare(a.name, b.name)
        || compare(a.content ?? '', b.content ?? '') || compare(a.ear, b.ear)
        || compare(a.batch ?? '', b.batch ?? '') || compare(Number(a.frequency), Number(b.frequency)));
    const factorValid = Number.isFinite(coefficient) && coefficient >= 0;
    const report = (file, line, level, reason, status = '無法判定') => {
        issues.push([file.name, file.ear, file.data?.distinct?.join(' / ') ?? '',
            file.frequency ?? '', line == null ? '' : String(line), level, status, reason]);
    };
    if (!factorValid) report({ name: '', ear: '' }, null, '', '門檻係數須為有限的非負數。');
    for (const file of ordered) {
        if (file.error) report(file, null, '', file.error);
        else if (!['L', 'R'].includes(file.ear) || !Number.isFinite(Number(file.frequency))
            || Number(file.frequency) <= 0 || file.frequencyConflict) {
            report(file, null, '', '請確認耳別及頻率。');
        }
        if (!file.error) {
            if (!groups.has(file.content)) groups.set(file.content, []);
            groups.get(file.content).push(file);
        }
    }
    const candidates = [];
    for (const sources of groups.values()) {
        const scope = entry => JSON.stringify([entry.batch ?? '', entry.ear, Number(entry.frequency)]);
        const byBatch = Map.groupBy(sources, entry => entry.batch ?? '');
        for (const batch of byBatch.values()) {
            if (new Set(batch.map(scope)).size !== 1) {
                for (const entry of batch) report(entry, null, '', '相同內容有不同耳別或頻率，請確認歸屬。');
                continue;
            }
            const chosen = batch.find(entry => !entry.frequencyConflict && entry.official)
                ?? batch.find(entry => !entry.frequencyConflict);
            if (!chosen || !['L', 'R'].includes(chosen.ear) || !(Number(chosen.frequency) > 0)
                || !Number.isFinite(Number(chosen.frequency)) || !factorValid) continue;
            if (batch.length > 1) {
                for (const entry of batch) report(entry, null, '', `相同內容只計算一次。採用來源 ${chosen.name}。`, '提示');
            }
            candidates.push(chosen);
        }
    }
    const records = new Map();
    const conflicts = new Map();
    for (const file of candidates) {
        file.data.records.forEach((record, index) => {
            if (!Number.isSafeInteger(record)) return;
            const key = JSON.stringify([file.batch ?? '', record]);
            if (!records.has(key)) records.set(key, []);
            records.get(key).push({ file, index });
        });
    }
    for (const entries of records.values()) {
        if (entries.length < 2) continue;
        for (const { file, index } of entries) {
            if (!conflicts.has(file)) conflicts.set(file, new Set());
            conflicts.get(file).add(index);
        }
    }
    for (const [batch, entries] of Map.groupBy(candidates, file => file.batch ?? '')) {
        const numbers = [...new Set(entries.flatMap(file => file.data.records.filter(Number.isSafeInteger)))]
            .sort((a, b) => a - b);
        if (entries.length > 1 && numbers.some((value, index) => index && value > numbers[index - 1] + 1)) {
            report({ name: batch, ear: '' }, null, '', '整批 Rec No. 有缺號。各檔案仍依自身紀錄驗證。', '提示');
        }
    }
    for (const chosen of candidates) {
        const issue = (line, level, reason, status) => report(chosen, line, level, reason, status);
        for (const index of conflicts.get(chosen) ?? []) {
            issue(chosen.data.rows[index].line, '', '同批次的 Rec No. 有衝突。');
        }
        if (chosen.frequencyConfirmed) issue(null, '', '使用者已確認頻率標籤。', '提示');
        const measurement = prepare(chosen, issue, conflicts.get(chosen));
        if (!measurement) continue;
        valid.push({
            ...chosen, measurement,
            report: (index, reason) => issue(
                chosen.data.rows[measurement.positions[index]]?.line, levels[index] ?? '', reason),
        });
    }
    for (const peers of Map.groupBy(valid, file => JSON.stringify([file.batch ?? '', Number(file.frequency)])).values()) {
        if (new Set(peers.map(file => JSON.stringify([file.measurement.signal, file.measurement.settings]))).size > 1) {
            for (const file of peers) report(file, null, '', '同批同頻率的頻譜格式、訊號欄或 F1/F2/F3 有差異。', '提示');
        }
    }
    for (const entries of Map.groupBy(valid, file => JSON.stringify([file.ear, Number(file.frequency)])).values()) {
        if (entries.length < 2) continue;
        const selected = entries.filter(file => file.official);
        entries.forEach((file, index) => {
            const state = selected.length !== 1 ? '尚未選定正式筆別' : file === selected[0] ? '正式' : '分筆';
            file.label = `${Number(file.frequency)}k [${index + 1} ${state}]`;
            report(file, null, '', `${file.label}，各筆獨立計算。`, '提示');
        });
    }
    const result = calculateResult(valid, coefficient);
    const columns = ['來源', '耳別', '原始頻率（Hz）', '確認頻率（kHz）', '原始列號', '刺激級別', '狀態', '原因'];
    const detail = issues.length ? [[], columns, ...issues] : [];
    return { ...result, rows: [...(valid.length ? result.rows : []), ...detail], issues, count: valid.length };
}
