import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { calculateRows, downloadName, encodeCSV, inferMetadata, readMeasurement } from './formatter.mjs';
import { inspectMeasurement, validateBatch } from './batch-validation.mjs';

function syntheticCSV(passes, hz) {
    const header = ['AudFreq()', 'F1(hz)', 'V1(dBv)', 'F2(hz)', 'V2(dBv)', 'F3(hz)', 'V3(dBv)',
        ...Array.from({ length: 6 }, (_, i) => `P${i}`), ...Array.from({ length: 27 }, (_, i) => i)];
    const rows = Array.from({ length: 7 }, (_, i) => {
        const signal = i < passes ? -50 + i / 10 : -100 - i / 10;
        const bins = Array.from({ length: 27 }, (_, bin) => bin === 13 ? signal : -80 + bin % 4);
        return [hz, 1, 2, 3, 4, 5, signal, 0, 0, 0, 0, 0, 0, ...bins];
    });
    return encodeCSV([header, ...rows]);
}

const { cases } = JSON.parse(readFileSync(new URL('./test/python-baseline.json', import.meta.url)));
for (const fixture of cases) {
    test(`Python baseline: ${fixture.id}`, () => {
        const files = fixture.files.map(file => ({ ...file, measurement: readMeasurement(file.csv) }));
        for (const file of files) {
            if (file.analysis) {
                assert.deepEqual(file.measurement.noise, file.analysis.noise.map(
                    row => row.map(value => value ?? NaN)));
            }
        }
        const rows = calculateRows(files, fixture.coefficient);
        if (['left-boundary', 'missing-spectrum-value'].includes(fixture.id)) {
            assert.ok(rows.some(row => row.includes('無法判定')));
            return;
        }
        if (fixture.error) {
            const { ear, frequency } = files[0];
            const start = ear === 'L' ? 0 : rows.length / 2;
            assert.deepEqual(rows[start + 1].slice(12), [`${frequency}k`, '75+', 'NA']);
            assert.deepEqual(rows.slice(start + 1, start + 8).map(row => row[10]), Array(7).fill('fail'));
        } else {
            assert.equal(encodeCSV(rows), fixture.expected);
        }
        assert.equal(downloadName(fixture.title), fixture.filename ?? (
            fixture.id === 'changed-coefficient' ? 'factor_output.csv' : 'output.csv'));
    });
}

test('解析、待確認狀態與檔名清理', () => {
    assert.equal(readMeasurement('\uFEFF' + syntheticCSV(7, 1500).replace('P0', '"with, comma"')).noise[0].length, 20);
    assert.throws(() => readMeasurement('unknown'), /缺少欄位/);
    assert.throws(() => readMeasurement('"bad'), /引號/);
    assert.deepEqual(inferMetadata('Demo 1.5k_R.CSV'), { ear: 'R', frequency: '1.5', title: 'Demo' });
    assert.deepEqual(inferMetadata('unknown.csv'), { ear: '', frequency: '', title: 'unknown' });
    assert.equal(downloadName(' '), 'output.csv');
    assert.equal(downloadName('Demo.csv'), 'Demo.csv_output.csv');
});

const labels = ['85_75', '75_65', '65_55', '55_45', '45_35', '35_25', '25_15'];
function batchFile({ name = 'test 8k_L.csv', ear = 'L', passes = 2, mutate = () => {} } = {}) {
    const rows = syntheticCSV(passes, 8000).trim().split(/\r?\n/).map(row => row.split(','));
    rows[0][7] = 'Level()';
    rows.slice(1).forEach((row, index) => { row[7] = labels[index]; });
    mutate(rows);
    const content = encodeCSV(rows);
    return { name, ear, frequency: 8, content, data: inspectMeasurement(content) };
}

test('批次去重、順序還原、歸屬衝突與分筆', () => {
    const base = batchFile();
    const initial = validateBatch([base], 2);
    assert.equal(initial.count, 1);
    assert.equal(initial.issues.length, 0);
    const reordered = batchFile({ mutate: rows => { [rows[1], rows[2]] = [rows[2], rows[1]]; } });
    assert.deepEqual(validateBatch([reordered], 2).rows, initial.rows);
    assert.equal(validateBatch([base, { ...base, name: 'duplicate.csv' }], 2).count, 1);
    assert.equal(validateBatch([base, { ...base, ear: 'R' }], 2).count, 0);
    const second = { ...batchFile({ name: 'second.csv', passes: 1 }), official: true };
    assert.deepEqual(validateBatch([base, second], 2), validateBatch([second, base], 2));
    assert.equal(validateBatch([base, second], 2).count, 2);
    assert.ok(validateBatch([base, second], 2).rows.flat().some(cell => cell.includes('正式')));
});

test('部分級別、無效數值、視窗外數值及錯誤下載', () => {
    const base = batchFile();
    const initial = validateBatch([base], 2);
    const outside = batchFile({ mutate: rows => { rows[1][13] = 'Infinity'; } });
    assert.deepEqual(validateBatch([outside], 2).rows, initial.rows);
    const inside = batchFile({ mutate: rows => { rows[2][22] = 'NaN'; } });
    const invalid = validateBatch([inside], 2);
    assert.equal(invalid.rows[2][10], '無法判定');
    assert.equal(invalid.rows[1][13], 'NA');
    assert.equal(invalid.rows[3][10], 'fail');
    const missing = batchFile({ mutate: rows => { rows.splice(2, 1); } });
    assert.equal(validateBatch([missing], 2).rows[2][10], '無法判定');
    const error = validateBatch([{ name: 'invalid.csv', error: 'CSV 錯誤' }], NaN);
    assert.equal(error.count, 0);
    assert.equal(error.issues.length, 2);
    assert.match(encodeCSV(error.rows), /invalid\.csv/);
});

test('記錄重號、檔間缺號及檔內頻率衝突', () => {
    const records = (first, next = () => {}) => rows => {
        rows[0][8] = 'Rec No.';
        rows.slice(1).forEach((row, index) => { row[8] = first + index; });
        next(rows);
    };
    const first = batchFile({ mutate: records(1) });
    const second = batchFile({ name: 'second.csv', ear: 'R', mutate: records(7) });
    const overlap = validateBatch([first, second], 2);
    assert.equal(overlap.count, 2);
    assert.ok(overlap.issues.some(row => row[7].includes('Rec No. 有衝突')));
    assert.equal(validateBatch([first, { ...second, batch: 'separate' }], 2).issues.length, 0);
    const gap = batchFile({ name: 'gap.csv', ear: 'R', mutate: records(15) });
    assert.ok(validateBatch([first, gap], 2).issues.some(row => row[7].includes('整批 Rec No. 有缺號')));
    const mixed = batchFile({ mutate: rows => { rows[2][0] = 9000; } });
    assert.equal(validateBatch([{ ...mixed, frequencyConflict: true }], 2).count, 0);
    const confirmed = validateBatch([{ ...mixed, frequencyConfirmed: true }], 2);
    assert.equal(confirmed.rows[2][10], '無法判定');
    assert.equal(confirmed.rows[3][10], 'fail');
});
