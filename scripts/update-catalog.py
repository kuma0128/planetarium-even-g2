"""Rebuild the bundled, offline catalogs from immutable upstream revisions."""
import csv
import io
import json
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
HYG = "https://raw.githubusercontent.com/astronexus/HYG-Database/c7f7f883fe678cc7680169a50ccd7dcc49b060ce/"
CELESTIAL = "https://raw.githubusercontent.com/ofrohn/d3-celestial/7e720a3de062059d4c5400a379146a601d9010e0/"


def read(url):
    with urlopen(url, timeout=90) as response:
        return response.read().decode("utf-8-sig")


target = ROOT / "src" / "data"
target.mkdir(parents=True, exist_ok=True)
stars = []
for row in csv.DictReader(io.StringIO(read(HYG + "hyg/CURRENT/hygdata_v41.csv"))):
    if row["id"] == "0" or not row["mag"] or float(row["mag"]) > 5.5:
        continue
    # Hipparcos ID, proper name, J2000 RA (hours), Dec (degrees), V magnitude,
    # proper motions mu_alpha*cos(delta), mu_delta (mas/year).
    stars.append([int(row["hip"] or 0), row["proper"], *[
        float(row[k] or 0) for k in ("ra", "dec", "mag", "pmra", "pmdec")]])
stars.sort(key=lambda s: s[4])
(target / "stars.json").write_text(json.dumps(stars, ensure_ascii=False, separators=(",", ":")) + "\n")
names = {f["id"]: f["properties"]["name"] for f in json.loads(read(CELESTIAL + "data/constellations.json"))["features"]}
lines = json.loads(read(CELESTIAL + "data/constellations.lines.json"))["features"]
constellations = [[f["id"], names[f["id"]], f["geometry"]["coordinates"]] for f in lines]
(target / "constellations.json").write_text(json.dumps(constellations, ensure_ascii=False, separators=(",", ":")) + "\n")
licenses = ROOT / "public" / "licenses"
licenses.mkdir(parents=True, exist_ok=True)
(licenses / "HYG.md").write_text(read(HYG + "LICENSE"))
(licenses / "D3-Celestial.txt").write_text(read(CELESTIAL + "LICENSE"))
print(f"Bundled {len(stars)} stars and {len(constellations)} constellations.")
