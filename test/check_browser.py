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
        # Give the browser different initial metadata, then confirm the fixture values.
        guessed_ear = "R" if file["ear"] == "L" else "L"
        name = f"synthetic{index}_1k_{guessed_ear}.csv"
        page.locator("#fileInput").set_input_files(
            {"name": name, "mimeType": "text/csv", "buffer": file["csv"].encode()})
        button = page.get_by_role("button", name=name, exact=True)
        button.click()
        page.locator("#moveToLeft" if file["ear"] == "L" else "#moveToRight").click()
        button.locator("..").locator("input").fill(str(file["frequency"]))
    page.locator("#titleInput").fill(fixture["title"])
    page.locator("#thresholdCoef").fill(str(fixture["coefficient"]))
    page.locator("#calculateBtn").click()
    if fixture.get("error"):
        page.wait_for_selector("#status.error")
        assert f'KeyError: {fixture["error"]["message"]}' in page.locator("#status").inner_text()
        assert page.locator("#downloadBtn").is_disabled()
        return
    page.wait_for_selector("#results table")
    with page.expect_download() as event:
        page.locator("#downloadBtn").click()
    artifact = event.value
    assert artifact.suggested_filename == fixture["filename"]
    assert artifact.path().read_bytes() == fixture["expected"].encode("utf-8")
    preview = page.locator("#results tr").evaluate_all(
        "(rows) => rows.map(row => Array.from(row.cells, cell => cell.textContent))")
    assert preview == list(csv.reader(io.StringIO(fixture["expected"])))
    page.locator("#titleInput").fill("changed")
    assert page.locator("#downloadBtn").is_disabled()
    assert page.locator("#results").is_hidden()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--chrome")
    parser.add_argument("--fixture", type=Path, default=Path(__file__).with_name("python-baseline.json"))
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
        for fixture in fixtures["cases"]:
            verify(page, base, fixture)
            print(f'PASS {fixture["id"]}')
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
