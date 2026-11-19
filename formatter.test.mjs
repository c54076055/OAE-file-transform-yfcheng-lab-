import assert from 'node:assert/strict';
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

test('耳別與頻率採用介面值，門檻與雜訊符合基準', () => {
    const files = [
        { name: 'Demo 2k_L.csv', ear: 'R', frequency: '4.25', measurement: readMeasurement(syntheticCSV(3, 2000)) },
        { name: 'Demo 1.5k_R.csv', ear: 'R', frequency: '1.5', measurement: readMeasurement(syntheticCSV(0, 1500)) },
    ];
    const rows = calculateRows(files, 2);
    assert.deepEqual(rows[10].slice(0, 9), ['R', '1.5k', 'dBv', 'NF', 'NF_SD', '4.25k', 'dBv', 'NF', 'NF_SD']);
    assert.deepEqual(rows[11].slice(21), ['1.5k', '75+', 'NA']);
    assert.deepEqual(rows[12].slice(21, 23), ['4.25k', 55]);
    assert.ok(Math.abs(rows[12][23] - 41.52059991327961) < 1e-12);
});

test('解析、待確認狀態與檔名清理', () => {
    assert.equal(readMeasurement('\uFEFF' + syntheticCSV(7, 1500).replace('P0', '"with, comma"')).noise[0].length, 20);
    assert.throws(() => readMeasurement('unknown'), /缺少欄位/);
    assert.throws(() => readMeasurement('"bad'), /引號/);
    assert.deepEqual(inferMetadata('Demo 1.5k_R.CSV'), { ear: 'R', frequency: '1.5', title: 'Demo' });
    assert.deepEqual(inferMetadata('unknown.csv'), { ear: '', frequency: '', title: 'unknown' });
    assert.equal(downloadName(' '), 'output.csv');
    assert.equal(downloadName('Demo: result.csv'), 'Demo_ result.csv');
});
