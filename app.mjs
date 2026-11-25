import { downloadName, encodeCSV, inferMetadata } from './formatter.mjs';
import { inspectMeasurement, validateBatch } from './batch-validation.mjs';

const byId = id => document.getElementById(id);
const title = byId('titleInput');
const fileInput = byId('fileInput');
const dropArea = byId('dropArea');
const errors = byId('importErrors');
const coefficient = byId('thresholdCoef');
const calculate = byId('calculateBtn');
const download = byId('downloadBtn');
const results = byId('results');
const hint = byId('resultHint');
const status = byId('status');
const moves = { L: byId('moveToLeft'), R: byId('moveToRight') };
const panels = { '': byId('pendingFiles'), L: byId('leftFiles'), R: byId('rightFiles') };
const files = [];
let nextId = 0;
let selectedId;
let result;
let revision = 0;
let importing = 0;
let calculating = false;

function message(text, error = false) {
    status.textContent = text;
    status.classList.toggle('error', error);
}

function invalidate() {
    revision++;
    if (result) {
        result = undefined;
        results.replaceChildren();
        results.hidden = true;
        hint.hidden = false;
        hint.textContent = '輸入已變更，請重新計算。';
        message('');
    }
    download.disabled = true;
}

function updateControls() {
    const selected = files.find(file => file.id === selectedId);
    for (const [ear, button] of Object.entries(moves)) {
        button.disabled = !selected || selected.ear === ear;
    }
    calculate.disabled = importing > 0 || calculating;
}

const validFrequency = value => value !== '' && Number.isFinite(Number(value)) && Number(value) > 0;
const sortFrequency = file => validFrequency(file.frequency) ? Number(file.frequency) : Infinity;

function renderFiles() {
    for (const [ear, panel] of Object.entries(panels)) {
        const entries = files.filter(file => file.ear === ear)
            .sort((a, b) => sortFrequency(a) - sortFrequency(b));
        panel.replaceChildren();
        if (!entries.length) {
            const empty = document.createElement('li');
            empty.textContent = '尚無檔案';
            panel.append(empty);
        }
        for (const file of entries) {
            const row = document.createElement('li');
            row.className = 'file-row';
            const select = document.createElement('button');
            select.type = 'button';
            select.className = 'file-name';
            select.id = `file-${file.id}`;
            select.textContent = file.name;
            select.setAttribute('aria-pressed', String(selectedId === file.id));
            select.addEventListener('click', () => {
                selectedId = file.id;
                byId('fileLists').querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
                select.setAttribute('aria-pressed', 'true');
                updateControls();
            });
            select.addEventListener('keydown', event => {
                if (event.key !== 'Delete') return;
                event.preventDefault();
                removeFile(file);
            });

            const frequency = document.createElement('input');
            frequency.type = 'number';
            frequency.step = 'any';
            frequency.inputMode = 'decimal';
            frequency.className = 'frequency';
            frequency.id = `frequency-${file.id}`;
            frequency.value = file.frequency;
            frequency.title = file.data?.distinct.length
                ? `檔內頻率 ${file.data.distinct.join('、')} Hz${file.filenameFrequency ? `，檔名頻率 ${file.filenameFrequency} kHz` : ''}`
                : '檔內頻率無法確認';
            frequency.placeholder = '待確認 kHz';
            frequency.setAttribute('aria-label', `${file.name} 的頻率（kHz）`);
            frequency.setAttribute('aria-invalid', String(!validFrequency(file.frequency)));
            frequency.addEventListener('input', () => {
                file.frequency = frequency.value;
                file.frequencyConflict = !file.data?.frequency || file.data.frequency !== Number(file.frequency);
                frequency.setAttribute('aria-invalid', String(!validFrequency(file.frequency)));
                invalidate();
            });
            frequency.addEventListener('change', () => {
                if (!validFrequency(file.frequency)) message(`${file.name} 的頻率須為正數（kHz）。`, true);
                // Reorder after focus leaves the field so a click on another control still lands.
                frequency.addEventListener('focusout', () => {
                    requestAnimationFrame(() => {
                        const focusId = document.activeElement?.id;
                        renderFiles();
                        if (focusId) byId(focusId)?.focus();
                    });
                }, { once: true });
            });

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = '移除';
            remove.setAttribute('aria-label', `移除 ${file.name}`);
            remove.addEventListener('click', () => removeFile(file));
            row.append(select, frequency, remove);
            if (file.frequencyConflict) {
                const confirm = document.createElement('button');
                confirm.type = 'button';
                confirm.textContent = '確認頻率';
                confirm.addEventListener('click', () => {
                    if (!validFrequency(file.frequency)) return;
                    file.frequencyConflict = false;
                    file.frequencyConfirmed = true;
                    invalidate();
                    renderFiles();
                });
                row.append(confirm);
            }
            panel.append(row);
        }
    }
    byId('pendingPanel').hidden = !files.some(file => !file.ear);
    updateControls();
}

function removeFile(file) {
    files.splice(files.indexOf(file), 1);
    if (selectedId === file.id) selectedId = undefined;
    invalidate();
    renderFiles();
    (byId('fileLists').querySelector('.file-name') ?? byId('chooseFiles')).focus();
}

for (const [ear, button] of Object.entries(moves)) {
    button.addEventListener('click', () => {
        const file = files.find(entry => entry.id === selectedId);
        file.ear = ear;
        invalidate();
        renderFiles();
        byId(`file-${file.id}`).focus();
    });
}

async function importFiles(batch) {
    if (!batch.length) return;
    invalidate();
    if (!importing) errors.replaceChildren();
    importing++;
    updateControls();
    message('正在讀取檔案…');
    const entries = await Promise.all(batch.map(async file => {
        try {
            if (!/\.csv$/i.test(file.name)) throw new Error('只支援 .csv 檔案。');
            const bytes = await file.arrayBuffer().catch(() => { throw new Error('無法讀取檔案。'); });
            let content;
            try {
                content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
            } catch {
                throw new Error('CSV 須使用 UTF-8 編碼。');
            }
            const data = inspectMeasurement(content);
            const metadata = inferMetadata(file.name);
            const frequency = data.frequency ? String(data.frequency) : metadata.frequency;
            const frequencyConflict = !data.frequency
                || (metadata.frequency && Number(metadata.frequency) !== data.frequency)
                || data.frequencies.some(value => !Number.isFinite(value) || value <= 0);
            return { ...metadata, id: nextId++, name: file.name, data, content, frequency, frequencyConflict,
                filenameFrequency: metadata.frequency };
        } catch (error) {
            const item = document.createElement('li');
            item.textContent = `${file.name}：${error.message}`;
            errors.append(item);
            errors.hidden = false;
            return { ...inferMetadata(file.name), id: nextId++, name: file.name, error: error.message };
        }
    }));
    const valid = entries.filter(Boolean);
    if (valid.length) {
        files.push(...valid);
        if (!title.value.trim()) title.value = valid[0].title;
        invalidate();
    }
    importing--;
    errors.hidden = !errors.children.length;
    renderFiles();
    if (!importing) message(`清單共有 ${files.length} 個檔案。`);
}

byId('chooseFiles').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
    importFiles(Array.from(fileInput.files));
    fileInput.value = '';
});
for (const event of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    dropArea.addEventListener(event, e => {
        e.preventDefault();
        dropArea.classList.toggle('active', event === 'dragenter' || event === 'dragover');
        if (event === 'drop') importFiles(Array.from(e.dataTransfer.files));
    });
}
title.addEventListener('input', invalidate);
coefficient.addEventListener('input', () => {
    coefficient.removeAttribute('aria-invalid');
    invalidate();
});

function showRows(rows) {
    const table = document.createElement('table');
    const body = table.createTBody();
    for (const values of rows) {
        const row = body.insertRow();
        for (const entry of values) {
            const value = String(entry);
            const cell = document.createElement(['L', 'R'].includes(values[0]) ? 'th' : 'td');
            cell.textContent = value;
            if (/^[+-]?(?:\d|inf$)/.test(value) && !value.includes('_') && !value.endsWith('k')) {
                cell.className = 'number';
            }
            if (value === 'pass' || value === 'fail') cell.className = value;
            row.append(cell);
        }
    }
    results.replaceChildren(table);
    results.hidden = false;
    hint.hidden = true;
}

calculate.addEventListener('click', async () => {
    if (!files.length) {
        message('請先匯入至少一個有效的 CSV 檔案。', true);
        byId('chooseFiles').focus();
        return;
    }
    const factor = coefficient.valueAsNumber;
    if (!Number.isFinite(factor) || factor < 0) {
        coefficient.setAttribute('aria-invalid', 'true');
    }
    invalidate();
    const current = revision;
    calculating = true;
    updateControls();
    message('正在計算…');
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    try {
        if (current !== revision || importing) {
            message('輸入已變更，請重新計算。');
            return;
        }
        const { rows, reviews, count, issues } = validateBatch(files, factor);
        showRows(rows);
        result = { csv: encodeCSV(rows), name: downloadName(title.value) };
        download.disabled = false;
        const locations = reviews.map(({ ear, frequencyLabel }) =>
            `${ear === 'L' ? '左耳' : '右耳'} ${frequencyLabel}Hz`);
        const reviewMessage = locations.length ? `待複核（${locations.join('、')}）。` : '';
        message(`已完成 ${count} 筆計算。${issues.length ? `有 ${issues.length} 筆問題紀錄。` : ''}${reviewMessage}`);
    } catch (error) {
        message(error.message, true);
    } finally {
        calculating = false;
        updateControls();
    }
});

download.addEventListener('click', () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([result.csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = result.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
});

renderFiles();
