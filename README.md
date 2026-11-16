# ve

The site at <https://brendanjmeade.github.io/ve/>: viscoelastic earthquake
cycles solved with boundary elements alone, moved through time in a browser.

The models are solved with [mbem](https://github.com/brendanjmeade/mbem), a
mollified boundary element method. This repository holds no solver. It holds
the site (`website/`, Astro and three.js), the script that turns stored mbem
runs into the site's data, and that data.

## Layout

| path | what it is |
|---|---|
| `website/src/pages/` | Five pages: home, Concepts, Theory, Running, Examples. |
| `website/src/content/` | The prose of Concepts, Theory and Running, MDX with KaTeX. |
| `website/src/viz/` | `payload.ts` (loading, and the one sum the page does), `scene.ts` (sheets in a 3-D scene), `view.ts` (a model at a time), `timeline.ts` (the clock and its slider, shared by every moving figure), `profile.ts` (the profile chart), `weights.ts` (the Theory page's figure), `controls.ts`, `hero.ts`. |
| `website/src/styles/main.css` | Shared with the mbem and kes sites; the additions at the end are this site's. |
| `website/scripts/make_payload.py` | Stored mbem runs to `website/public/data/`. |
| `website/public/data/` | The payload: per model a JSON, meshes, modes and a profile. |
| `.github/workflows/deploy-website.yml` | Builds `website/` and deploys it to GitHub Pages on a push to `main` that touches it. |

## Working on it

```bash
cd website
npm install
npm run dev        # http://localhost:4321/ve/
npm run build      # into website/dist
```

## The data

```bash
python website/scripts/make_payload.py --runs ~/mbem/runs
```

needs mbem installed (`pip install -e .` in its checkout) and the three
studies named at the top of the script in its `runs/`. The Running page gives
the commands that make them. A model's section through the volume is read
from `runs/section-<model>`, made by

```bash
python -m mbem sample runs/<study>/<run> --section y=0 --spacing 4 \
    --no-eigenstress --out runs/section-<model>
```

and a model without one is written without it.

A stored Laplace run is one boundary solution per Laplace state, and time is
a linear map of that stack whose weights sum to about 200 in magnitude. So
the states are not shipped. Each field is shipped as

- **modes**: an orthonormal basis of the stack, float32; and
- **tables**: for each quantity of time (displacement since the earthquake,
  total, velocity, the velocity of a locked fault through its cycle), the
  weights already applied, one short row per time.

The page multiplies one row into the modes. The functions that make both are
`mbem.webexport.encode_modes` and `time_tables`; they live in mbem so that
its gates check them (`verify_volume`, clause i), and this repository's script
only names the studies and writes the schema `payload.ts` reads.

## Conventions

- Every fetch goes through `import.meta.env.BASE_URL`. A leading `/data`
  works in dev and 404s under `/ve` in production.
- No float textures. Values reach the GPU as vertex attributes and colour
  comes from an 8-bit lookup table, because a float texture cannot be
  linearly filtered on about half of iOS devices and fails as a black
  surface, not as an error.
- A 3-D scene lives in a `.stage`: a box whose height comes from its width,
  with the canvas filling it by CSS. A WebGL canvas's own size is its drawing
  buffer's, the box times the display's pixel density, so one left to size
  itself is drawn twice too large on a 2x display and cut off on the right.
  Check a change to the scene at a device scale factor of 2 as well as 1.
- Time is one `Clock` per figure, and every slider on it is a `Timeline`.
  Whatever moves subscribes to the clock; nothing keeps a time of its own.
- The Laplace inversion is not restated in TypeScript. If a quantity of time
  is wanted that the tables do not hold, add it to `time_weights` in mbem.
- A surface is drawn through its elements' values averaged to the nodes, and
  never across a fault. The page says so wherever it matters.
- Light only, as the sibling sites are.
