import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { calculateRows, downloadName, encodeCSV, inferMetadata, readMeasurement } from './formatter.mjs';

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
        const calculate = () => calculateRows(files, fixture.coefficient);
        if (fixture.error) {
            assert.throws(calculate, new RegExp(`KeyError: ${fixture.error.message}`));
            return;
        }
        assert.equal(encodeCSV(calculate()), fixture.expected);
        assert.equal(downloadName(fixture.title), fixture.filename);
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
