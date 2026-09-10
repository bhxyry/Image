---
name: paper-figure-extract
description: Extract every figure and table from a paper PDF into a new per-paper folder in this repo, named Figure_N.png / Table_N.png, then git-commit the result. Use only when the user explicitly asks to extract a paper's figures/tables (invoke manually as /skill:paper-figure-extract <paper.pdf>).
disable-model-invocation: true
---

# Paper Figure / Table Extractor

Given a paper PDF, create a short-named folder under `image/` in this repo,
extract **all** figures and tables as tightly cropped PNGs named `Figure_1.png`,
`Figure_2.png`, … and `Table_1.png`, … (caption included, no other naming info),
and commit them.

## Repo convention

- Git repo root: `git rev-parse --show-toplevel`
- Output lives in `<repo>/image/<ShortName>/`
- Only add the new folder when committing; never sweep unrelated changes.

## Setup (once)

```bash
cd .pi/skills/paper-figure-extract
npm install        # installs mupdf + pngjs
```

## Workflow

1. Inspect the paper to get the title and a short folder name:

   ```bash
   node .pi/skills/paper-figure-extract/scripts/extract.mjs "<paper.pdf>" --info
   ```

   This prints the detected title and a suggested short name. Prefer a short
   system/acronym from the title (e.g. `Khost`, `FirmAgent`); override with
   `--name` if the suggestion is awkward.

2. Extract into the repo folder:

   ```bash
   node .pi/skills/paper-figure-extract/scripts/extract.mjs "<paper.pdf>" \
       --out "<repo>/image/<ShortName>" [--name <ShortName>]
   ```

   The script auto-detects two/single-column layout, finds `Figure N:` /
   `Figure N.` / `Table N:` captions, crops each item (graphic + label +
   caption), and prints one line per image with its size/position. Lines
   tagged `[fallback]` had no ruling/graphic near the caption — check those.

3. Sanity-check: the printed count should match the number of captions. If an
   item is obviously wrong (e.g. full-column height, missing table rows),
   re-run after fixing, or fall back to rendering the page and using `--scale`.

4. Commit only the new folder:

   ```bash
   cd "$(git rev-parse --show-toplevel)"
   git add image/<ShortName>
   git commit -m "Add <ShortName> paper figures"
   ```

## Script options

| Option | Meaning |
|--------|---------|
| `--out DIR` | output directory (required for extraction) |
| `--name SHORT` | short folder name (skips auto-suggestion) |
| `--info` | print title, short name, layout and caption list only |
| `--scale N` | render scale, default 4 (=288 dpi) |

## Notes

- Requires Node.js (available in this environment); Python is not used.
- Tables whose body is merged into the caption block are handled automatically;
  rule-only tables use nearby text rows.
- Figures/tables that span both columns are detected via the column gutter.
