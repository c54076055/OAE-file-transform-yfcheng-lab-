"""Generate synthetic cases with the selected desktop tool.py or tool.pyc."""
import argparse
import csv
import importlib.util
import json
import random
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy
import pandas


def measurement(passes, freq, signal_bin=13, duplicate=False, close=False, variation=""):
    headers = ["AudFreq()", "F1(hz)", "V1(dBv)", "F2(hz)", "V2(dBv)",
               "F3(hz)", "V3(dBv)"] + [f"meta{i}" for i in range(6)]
    rows = [headers + list(range(27))]
    rng = random.Random(123)
    for index in range(7):
        signal = -70 - index if index < passes else -90 - index
        if close:
            signal = -80.00000001 if index >= passes else -79.99999999
        if variation == "fractional-spl" and index == 0:
            signal = -61.516278
        spectrum = [-80 if close else -82 + i % 5 for i in range(27)]
        if variation == "decimal-spectrum":
            spectrum = [round(rng.uniform(-87, -75), 6) for _ in spectrum]
        if variation == "full-precision-spectrum":
            spectrum = [rng.uniform(-87, -75) for _ in spectrum]
        if variation == "identical-signal-columns":
            spectrum[12] = signal
        if variation == "missing-spectrum-value" and index == 6:
            spectrum[4] = ""
        spectrum[signal_bin] = signal
        if duplicate and index == 0:
            spectrum[3] = signal
        rows.append([round(freq * 1000), 9000, -20, 10800, -30, 7200, signal] + [0] * 6 + spectrum)
    return rows


def generate(tool):
    cases = [(f"passes-{n}", [(n, "L", 11.3, 13, False, False)], None, 2)
             for n in range(8)]
    cases += [
        ("unequal", [(4, "L", 12, 13, True, False), (5, "L", 8.5, 25, False, False),
                     (2, "R", 9, 13, False, False)], "樣本,01", 1.25),
        ("left-boundary", [(4, "R", 8, 3, False, False)], None, 2),
        ("equal-line", [(3, "R", 9, 13, False, True)], "close", 0),
        ("changed-coefficient", [(7, "L", 10, 13, True, False)], "factor", 20),
        ("fractional-spl", [(4, "R", 11.3, 13, False, False)], "precision", 2),
        ("decimal-spectrum", [(4, "R", 11.3, 13, False, False)], "decimal", 2),
        ("full-precision-spectrum", [(4, "R", 11.3, 13, False, False)], "full", 2),
        ("identical-signal-columns", [(4, "L", 11.3, 13, False, False)], "duplicate", 2),
        ("missing-spectrum-value", [(4, "R", 11.3, 13, False, False)], "missing", 2),
    ]
    for key, inputs, title, coefficient in cases:
        with TemporaryDirectory() as directory:
            folder = Path(directory)
            formatter = tool.Formatter([], name="", dataDir=directory)
            formatter.editName(title)
            case = dict(id=key, title=title or "", coefficient=coefficient, files=[])
            try:
                for index, (passes, ear, freq, signal_bin, duplicate, close) in enumerate(inputs):
                    name = f"synthetic{index}_{freq}k_{ear}.csv"
                    path = folder / name
                    with path.open("w", encoding="utf-8", newline="") as stream:
                        csv.writer(stream).writerows(measurement(
                            passes, freq, signal_bin, duplicate, close, key))
                    case["files"].append(dict(name=name, ear=ear, frequency=freq, csv=path.read_text()))
                    data = formatter.csv2class(str(path))
                    data.freq = freq
                    data.indexCol.columns = [f"{freq}k"]
                    samples = data.anlyDf.astype(object).where(data.anlyDf.notna(), None)
                    analysis = dict(signalBin=12 if key == "identical-signal-columns" else signal_bin,
                                    noise=samples.values.tolist())
                    case["files"][-1]["analysis"] = analysis
                    # Call directly to capture failures that the GUI worker thread raises.
                    try:
                        data.calculate(coefficient)
                    finally:
                        if hasattr(data, "splDf"):
                            analysis["passes"] = int((data.splDf["Threshold"] == "pass").sum())
                    analysis.update(threshold=data.threshold, summaryNoise=data.thresNF)
                formatter.calculateAll(coefficient)
                formatter.format()
                formatter.to_csv()
                output = next(folder.glob("*output.csv"))
                case.update(filename=output.name, expected=output.read_bytes().decode("utf-8"))
            except (IndexError, KeyError) as error:
                case["error"] = dict(type=type(error).__name__, message=str(error))
            yield case


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("tool", type=Path)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("oae_desktop_tool", args.tool)
    tool = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tool)
    output = dict(numpy=numpy.__version__, pandas=pandas.__version__, cases=list(generate(tool)))
    Path(__file__).with_name("python-baseline.json").write_bytes(
        (json.dumps(output, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8"))
