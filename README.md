# 3DParametricGraph

A lightweight web app for graphing 3D **parametric curves**, **parametric surfaces**, and **solids**.

## Run locally

Because this is a static web app, you can run it with any static server:

```bash
cd /path/to/3DParametricGraph
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Features

- Add multiple graph entries (Desmos-style list workflow)
- Single expression input per graph card:
  - Parametric curve/surface tuple: `(x(...), y(...), z(...))`
  - Explicit surface form: `z=f(x,y)` (mapped over `u,v` ranges as x/y domain)
- Graph types:
  - Curve: `x(t), y(t), z(t)` with `t` range
  - Surface: `x(u,v), y(u,v), z(u,v)` with `u,v` ranges
  - Solid: boolean/implicit expression in `x,y,z` (example: `x^2+y^2+z^2-4<=0`)
- Light/dark mode toggle
- Mobile-friendly responsive control panel + viewport
- Orbit/zoom/pan controls for easy 3D navigation
