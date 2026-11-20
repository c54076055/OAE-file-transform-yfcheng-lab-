"""Check the same Python baselines in a running Pages deployment."""
import argparse
import csv
import io
import json
from pathlib import Path

from playwright.sync_api import sync_playwright


def verify(page, base, fixture):
    page.goto(base)
    for index, file in enumerate(fixture["files"]):
        # Add explicit stimulus levels without changing the readings used by Python.
        rows = list(csv.reader(io.StringIO(file["csv"])))
        rows[0][7] = "Level()"
        for level_index, row in enumerate(rows[1:]):
            row[7] = f"{85 - 10 * level_index}_{75 - 10 * level_index}"
        buffer = io.StringIO()
        csv.writer(buffer).writerows(rows)
        guessed_ear = "R" if file["ear"] == "L" else "L"
        name = f"synthetic{index}_{file['frequency']}k_{guessed_ear}.csv"
        page.locator("#fileInput").set_input_files(
            {"name": name, "mimeType": "text/csv", "buffer": buffer.getvalue().encode()})
        button = page.get_by_role("button", name=name, exact=True)
        button.click()
        page.locator("#moveToLeft" if file["ear"] == "L" else "#moveToRight").click()
        frequency = button.locator("..").locator("input.frequency")
        assert float(frequency.input_value()) == float(file["frequency"])
    page.locator("#titleInput").fill(fixture["title"])
    page.locator("#thresholdCoef").fill(str(fixture["coefficient"]))
    page.locator("#calculateBtn").click()
    page.wait_for_selector("#results table, #status.error")
    assert page.locator("#results table").is_visible(), page.locator("#status").inner_text()
    with page.expect_download() as event:
        page.locator("#downloadBtn").click()
    artifact = event.value
    filename = fixture.get("filename", "factor_output.csv" if fixture["id"] == "changed-coefficient"
                           else "output.csv")
    assert artifact.suggested_filename == filename
    downloaded = artifact.path().read_bytes()
    preview = page.locator("#results tr").evaluate_all(
        "(rows) => rows.map(row => Array.from(row.cells, cell => cell.textContent))")
    assert preview == list(csv.reader(io.StringIO(downloaded.decode("utf-8"))))
    problem_rows = [row for row in preview if len(row) == 8 and row[0] != "來源"]
    numeric = preview[:next((i for i, row in enumerate(preview) if not row), len(preview))]
    special = {
        "left-boundary": "雜訊視窗不足",
        "unequal": "雜訊視窗不足",
        "identical-signal-columns": "多個頻譜欄",
        "missing-spectrum-value": "無效數值",
    }
    if fixture["id"] in special:
        assert any(special[fixture["id"]] in row[-1] for row in problem_rows)
        if fixture["id"] == "unequal":
            assert len(numeric) > 0
        if fixture["id"] == "missing-spectrum-value":
            assert any("無法判定" in row for row in numeric)
    elif "expected" in fixture:
        assert downloaded == fixture["expected"].encode("utf-8")
    else:
        assert_summaries(page, numeric, fixture)
    page.locator("#titleInput").fill("changed")
    assert page.locator("#downloadBtn").is_disabled()
    assert page.locator("#results").is_hidden()


def assert_summaries(page, rows, fixture):
    status = page.locator("#status").inner_text()
    for ear, start in (("L", 0), ("R", len(rows) // 2)):
        files = sorted((f for f in fixture["files"] if f["ear"] == ear),
                       key=lambda f: float(f["frequency"]))
        summary = 3 + 9 * len(files)
        for index, file in enumerate(files):
            spl = 2 + 4 * len(files) + 5 * index
            flags = [row[spl + 4] for row in rows[start + 1:start + 8]]
            label = f'{float(file["frequency"]):g}k'
            pattern, threshold, noise_row = file.get("summary", ("fffffff", "75+", None))
            assert flags == [{"p": "pass", "f": "fail"}[flag] for flag in pattern]
            if "summary" in file:
                assert len({row[spl + 2] for row in rows[start + 1:start + 8]}) == 7
            nf = "NA" if noise_row is None else rows[start + noise_row][spl + 2]
            assert rows[start + index + 1][summary:summary + 3] == [label, threshold, nf]
            if threshold == "NA":
                ear_label = {"L": "左耳", "R": "右耳"}[ear]
                assert "待複核" in status and f"{ear_label} {label}Hz" in status
    if not any(f.get("summary", (None, "75+"))[1] == "NA" for f in fixture["files"]):
        assert "待複核" not in status


def mixed_summary_fixture(cases):
    source = {case["id"]: case["files"][0] for case in cases}
    passed = list(csv.reader(io.StringIO(source["passes-7"]["csv"])))
    failed = list(csv.reader(io.StringIO(source["passes-0"]["csv"])))
    header = passed[0]
    spectrum_columns = [index for index, label in enumerate(header)
                        if label.isdecimal() or label == "V3(dBv)"]
    files = []
    for ear, frequency, pattern, threshold, noise_row in (
        ("L", 16, "fffffff", "75+", None),
        ("L", 32, "pfpffff", "75.0", 1),
        ("L", 8, "fppffff", "NA", None),
        ("R", 4, "ppfffff", "65.0", 2),
        ("R", 2, "ppppppp", "15.0", 7),
        ("R", 8, "fpfpfff", "NA", None),
    ):
        rows = [header]
        for index, flag in enumerate(pattern, 1):
            row = (passed if flag == "p" else failed)[index].copy()
            row[0] = str(frequency * 1000)
            for column in spectrum_columns:
                row[column] = str(float(row[column]) + index / 2)
            rows.append(row)
        buffer = io.StringIO()
        csv.writer(buffer).writerows(rows)
        files.append(dict(ear=ear, frequency=frequency, csv=buffer.getvalue(),
                          summary=(pattern, threshold, noise_row)))
    return dict(id="mixed-summary", files=files, title="mixed", coefficient=2,
                filename="mixed_output.csv")


def verify_batch_conflicts(page, base, sample):
    page.goto(base)
    source = list(csv.reader(io.StringIO(sample["files"][0]["csv"])))
    source[0][7] = "Level()"
    for index, row in enumerate(source[1:]):
        row[7] = f"{85 - 10 * index}_{75 - 10 * index}"
    buffer = io.StringIO()
    csv.writer(buffer).writerows(source)
    first = "first_11.3k_L.csv"
    second = "copy_1k_L.csv"
    bad = "invalid.csv"
    page.locator("#fileInput").set_input_files([
        {"name": name, "mimeType": "text/csv",
         "buffer": b"bad" if name == bad else buffer.getvalue().encode()}
        for name in (first, second, bad)
    ])
    row = page.get_by_role("button", name=second, exact=True).locator("..")
    row.get_by_role("button", name="確認頻率").click()
    page.locator("#calculateBtn").click()
    page.wait_for_selector("#results table")
    assert "已完成 1 筆" in page.locator("#status").inner_text()
    assert "相同內容只計算一次" in page.locator("#results").inner_text()
    page.get_by_role("button", name=second, exact=True).click()
    page.locator("#moveToRight").click()
    assert page.locator("#downloadBtn").is_disabled()
    page.locator("#thresholdCoef").fill("-1")
    page.locator("#calculateBtn").click()
    page.wait_for_selector("#results table")
    with page.expect_download() as event:
        page.locator("#downloadBtn").click()
    content = event.value.path().read_text("utf-8")
    assert "門檻係數" in content and "不同耳別" in content and bad in content
    assert "dB SPL" not in content


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--chrome")
    parser.add_argument("--fixture", type=Path, default=Path(__file__).with_name("python-baseline.json"))
    parser.add_argument("--case")
    args = parser.parse_args()
    site = args.url.rstrip("/") + "/"
    base = site + "v2/"
    fixtures = json.loads(args.fixture.read_text("utf-8"))
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.chrome)
        page = browser.new_page()
        page_errors = []
        requests = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on("request", lambda request: requests.append(request))
        page.goto(site)
        sample = next(case for case in fixtures["cases"] if case["id"] == "passes-7")
        payload = sample["files"][0]["csv"].encode("utf-8")
        page.locator("#fileInput").set_input_files([
            {"name": f"synthetic_{ear}.csv", "mimeType": "text/csv", "buffer": payload}
            for ear in "LR"
        ])
        page.locator("#processBtn").click()
        page.wait_for_selector("#resultsTable table")
        with page.expect_download() as event:
            page.locator("#downloadBtn").click()
        assert event.value.suggested_filename == "testOut.csv"
        assert event.value.path().stat().st_size > 0
        page.locator("h1").get_by_role("link", name="新版", exact=True).click()
        page.wait_for_url(base)
        print("PASS legacy results, download and link to v2")
        requests.clear()
        page_errors.clear()
        cases = [*fixtures["cases"], mixed_summary_fixture(fixtures["cases"])]
        for fixture in cases:
            if args.case and fixture["id"] != args.case:
                continue
            verify(page, base, fixture)
            print(f'PASS {fixture["id"]}')
        if not args.case:
            verify_batch_conflicts(page, base, sample)
            print("PASS batch duplicates, conflicts and error-only download")
        assert not page_errors, page_errors
        assert all(request.url.startswith(site) and request.method == "GET"
                   and request.post_data is None for request in requests)
        page.goto(site + "csv_processor.html")
        page.wait_for_url(base)
        page.locator('a[href="../csv-viewer.html"]').click()
        page.locator("#file-input").set_input_files(
            {"name": "synthetic.csv", "mimeType": "text/csv", "buffer": b"a,b\n1,2\n"})
        page.wait_for_selector("#csv-preview table")
        print("PASS processor alias and independent viewer")
