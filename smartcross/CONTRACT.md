# SmartCross 3D presentation — model module contract

Project: a 16:9 pitch presentation rendered with Three.js r169. A camera flies through ONE daytime city
(Bishkek, Kyrgyzstan) between "shots"; HTML text panels sit on one side, the key 3D object on the other.
Every 3D model is built procedurally in code by these modules. The integrator (main.js, written separately)
imports the factories below exactly as specified — keep the names, parameters and return shapes.

## Hard rules (all modules)

- ES module, plain JavaScript. Imports ONLY `import * as THREE from 'three'` and `three/addons/...`
  (e.g. `import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'`).
  No network access at runtime: no loaders, no external textures, fonts or models. Procedural
  `THREE.CanvasTexture` built in code is fine (e.g. signage text, asphalt noise) — keep each canvas ≤ 512 px.
- Units: metres. Y up, ground at y = 0. Compass: North = −Z, South = +Z, East = +X, West = −X.
- Every model's FRONT faces local +Z (so `object.lookAt(p)` points the front at p). Origin at the
  footprint centre on the ground unless the spec says otherwise.
- Vehicles: left-hand drive, right-hand traffic. Facing +Z, the vehicle's LEFT side is local +X
  (driver sits on the +X side).
- Lighting (already set by the integrator — do not add lights except tiny emissive effects): one fixed sun
  from the south-west, ~46° high, direction-to-sun = normalize(−0.45, 0.75, 0.55); hemisphere fill; ACES
  filmic tone mapping; sRGB output; PMREM RoomEnvironment at 0.35 intensity. Daytime only.
- Shadows: `castShadow = true` and `receiveShadow = true` on solid meshes. Glass and decals: receive only.
- Materials: `MeshStandardMaterial` / `MeshPhysicalMaterial`, realistic roughness/metalness. Reuse
  materials through a module-level cache. Colours as hex in sRGB (three handles conversion).
  Glass: dark tinted, roughness ≈ 0.05–0.15, metalness ≈ 0.1–0.3, slightly reflective (envMap comes from the scene).
- Performance is a requirement: merge geometry by material (`mergeGeometries`; make attribute sets match —
  e.g. call `.toNonIndexed()` on all or none, delete `uv` where one part lacks it) and use `InstancedMesh`
  for repeated parts. Budgets are given per module. Avoid > 64 segments on small round parts.
- Determinism: use a seeded PRNG (e.g. mulberry32) so layouts look the same on every load. `Math.random` is
  not allowed in model code.
- Detail level: the user explicitly asked for DETAILED models — buildings with windows, frames, sills,
  roofs; cars with headlights, windshields, side windows, door seams, wheels; people with faces, hands,
  clothing. Stylised-realistic, clean, smooth, "high-end low-poly" look (bevelled/rounded where cheap:
  `RoundedBoxGeometry` from three/addons, lathe, extrude with bevel, capsule).
- Export `demo()` that returns a showcase (`THREE.Object3D` or `{ group, update(t, dt) }`) used only for previews.
- Document every export with a short JSDoc comment.

## Preview tool (use it — iterate until it looks great)

```
cd <project root>
node tools/preview.cjs src/<module>.js [--fn demo] [--out previews/<name>] [--t 1.5] \
     [--views '[{"pos":[x,y,z],"target":[x,y,z]}]'] [--w 1280 --h 720] [--fov 40]
```
Renders your `demo()` (or `--fn otherExport` with no args) under the project's exact sun/sky lighting,
from 4 automatic views or your custom views, writes `previews/<name>-<i>.png`, and prints draw calls,
triangle count, bounding box and console/page errors. `--t` advances `update(t, dt)` to time t (s) before
rendering. Open the PNGs with the Read tool and judge them critically; fix and re-render. Do at least three
render → critique → improve rounds, including close-ups (custom --views) of the finest details.
Each run takes ~10–40 s (software WebGL).

Only write `src/<your module>.js` and files under `previews/`. Do not edit other modules or tools.

## Module specs

### src/vehicles.js  (budget: whole fleet of 400 vehicles ≤ 60 draw calls)
- `VEHICLE_TYPES = ['sedan','hatch','suv','minibus','bus','pickup']`
  (minibus = white Mercedes-Sprinter-style "маршрутка" with a route-number board; bus = 12 m city bus).
- `VEHICLE_LENGTH` — object: type → overall length in metres (used for queue spacing).
- `createFleet(placements)` → `{ group, count, setPose(i, x, y, z, rotY), setBrake(i, on), commit() }`
  - `placements`: array of `{ type, color, x, z, rotY, brake }` (`color` hex for body paint; ignored for bus/minibus
    if you prefer their livery). `rotY` = rotation about Y; at 0 the front faces +Z.
  - Instanced: one `InstancedMesh` per (type × material) with `instanceColor` for paint. Brake lights brighter when
    `brake` is on (e.g. a separate emissive instanced layer you scale to 0 when off).
  - `setPose`/`setBrake` update instance matrices; `commit()` flags `instanceMatrix.needsUpdate`.
  - Detail per vehicle: shaped body (not a box: bonnet, cabin, boot / proper van and bus silhouettes), windshield,
    rear window, side windows, door seams, handles, mirrors, bumpers, grille, headlights, tail lights, number
    plates, wheels with tyre + rim, wheel arches. Bus/minibus: many side windows, doors, destination board.
- `createHeroCar({ color })` → `{ group, driverSeat, steeringWheel, update(t, dt) }`
  - A single, extra-detailed sedan for a close-up: real interior visible through glass (seats, dashboard,
    steering wheel, centre console, rear-view mirror). Glass here is see-through (opacity ≈ 0.25–0.35).
  - `driverSeat`: Object3D at the driver's H-point (hip point on the seat), on the +X side, facing +Z.
    In `driverSeat`-local coordinates the steering wheel centre is at (0, 0.40, 0.45), rim radius 0.19,
    rim plane tilted ~25° back from vertical (toward the driver). The integrator parents a driver figure
    (from people.js) to `driverSeat`.
  - `steeringWheel`: the wheel Object3D (so it can be wiggled). `update` may idle-vibrate the body slightly.
- `demo()`: a row of every type in several colours plus the hero car; front of each facing +Z.

### src/buildings.js  (budget: 150 buildings ≤ 80 draw calls total)
- `createBuildingKit()` → `{ add(spec), finish() }` ; `finish()` returns a `THREE.Group` with everything merged
  by material and windows/balconies/AC units/etc. as `InstancedMesh`es shared across all buildings.
- `spec = { x, z, rotY = 0, w, d, floors, style, color?, seed }` — footprint w (along local X) × d (local Z),
  centred at (x, z); main facade faces local +Z rotated by rotY; floor height 3 m (shop ground floor 4 m).
- Styles (Bishkek character):
  - `panel` — Soviet 9-storey panel block: panel joints, rows of windows, glazed balconies on the main facade,
    flat roof with parapet, roof exits, antennas; pastel/beige/white palettes.
  - `brick` — 4–5-storey brick "khrushchevka": warm brick colour, simple windows with sills, small balconies.
  - `office` — modern 8–16-storey glass/curtain-wall tower with mullions, entrance canopy, rooftop plant.
  - `shop` — 1–2-storey commercial building with large shopfronts, awnings and Cyrillic signs
    (CanvasTexture: «АПТЕКА», «ПРОДУКТЫ», «КАФЕ», «БАНК», «ОПТИКА», «ЦВЕТЫ» …).
  - `campus` — university building (modern 3–5 storeys, long, large windows, entrance portico with columns,
    rooftop sign "MANAS" style lettering on CanvasTexture is fine).
  - `house` — private one/two-storey house with pitched metal roof, chimney, fence-less.
- Windows everywhere: frame, glass (slight variation in tint/reflection per window), sill; doors; roof details.
- `demo()`: one of each style in a small row plus a dense mini-block.

### src/nature.js  (budget: 2,500 trees + 1,500 bushes ≤ 30 draw calls)
- `createVegetationKit()` → `{ addTree(x, z, { type, scale = 1, seed }), addBush(x, z, { scale = 1 }),
  addHedge(x1, z1, x2, z2, { height = 1.1 }), addFlowerBed(x, z, w, d), finish() }`; `finish()` returns a Group of
  InstancedMeshes (several variants per type for variety).
- Tree types: `poplar` (tall pyramidal poplar — Bishkek's signature street tree, 18–25 m), `elm` (round
  karagach crown, 9–12 m), `maple`, `oak`, `spruce` (Tian-Shan spruce, conical, 10–15 m), `birch`.
  Trunks with a couple of visible branches; crowns built from clustered displaced icosahedra / blobs with
  several greens (sunlit lighter, inner darker); no flat cards.
- `createLawn(w, d, { seed })` → Mesh: grass ground patch (centred at origin, top at y = 0.02) with subtle
  procedural colour variation; receives shadows.
- `createMountains()` → Group: the snowy Ala-Too range for the far southern horizon — placed already in world
  coordinates around z = +1800 … +2600, spanning x = −3000 … +3000, peaks 350–700 m high, snow caps above ~60 %
  of height, bluish aerial-perspective tint (no shadows needed, `castShadow=false`).
- `demo()`: a small grove with every tree type, bushes, hedge, flower bed on a lawn.

### src/people.js  (budget: each person ≤ 25 meshes; up to 40 people on screen)
- Shared: adults 1.70–1.85 m, origin at feet on ground (except the seated driver), facing +Z. Jointed hierarchy
  (neck, shoulders, elbows, wrists, hips, knees) so poses can be animated. Head with face: eyes (white + pupil),
  eyebrows, nose, mouth, ears, hair; hands with a thumb hint; shoes; clothing colours.
- `createPerson({ seed, kind = 'pedestrian' | 'student', gender, walking = true })` → `{ group, update(t, dt) }`
  (walk cycle in place; students carry backpacks).
- `createDriver({ angry = true, seed })` → `{ group, update(t, dt) }` — SEATED pose. Origin = the H-point
  (hip point); faces +Z; hands on a steering wheel whose centre is at (0, 0.40, 0.45) with rim radius 0.19
  (hands at about ±0.17 on the rim). Angry expression: brows angled down toward the nose, open shouting
  mouth / gritted teeth, reddish face; `update` animates frustration (head shakes, one hand slaps the wheel/horn,
  shoulders tense). Torso/head must look good from the front through a windshield and from the side window.
- `createWorker({ seed })` → `{ group, update(t, dt), toolTip }` — road worker: orange hi-vis vest with reflective
  stripes, white hard hat, gloves, work boots, holding a pneumatic jackhammer (detailed: handles, body, hose, chisel)
  in front of him; chisel tip on the ground at local (0, 0, 0.55); `toolTip` is an Object3D at the tip.
  `update` = realistic jackhammering: fast vertical vibration of the hammer, body and arms shaking, short pauses
  every few seconds where he lifts and repositions the tool.
- `createOfficer({ seed, pose = 'regulate' | 'stand' })` → `{ group, update(t, dt) }` — Kyrgyz traffic police
  officer: lime/yellow hi-vis jacket over dark-blue uniform, peaked cap (фуражка), white gloves, black-and-white
  striped baton (жезл). 'regulate' animates traffic-direction gestures (arm raised, baton pointing, body turning).
- `demo()`: a line-up of all variants (driver seated on a simple stool + a dummy wheel ring for the preview).

### src/roads.js  (budget: whole network ≤ 40 draw calls)
- `createRoadNetwork()` → `{ addRoad(spec), addIntersection(spec), addPath(points, width), finish() }`.
  `finish()` returns a Group with everything merged by material (asphalt, markings, curbs, sidewalk paving, …).
- `addRoad({ x1, z1, x2, z2, lanesPerDir = 2, laneWidth = 3.5, sidewalk = 5, median = 0, fresh = false })` —
  straight road along the segment (any direction): asphalt carriageway (slightly darker + smoother if `fresh`),
  white lane markings (dashed between same-direction lanes, double solid in the centre when median = 0;
  raised planted median with curbs when median > 0), 0.15 m raised curbs, sidewalks with paving pattern
  (sidewalk 0 = none). Road surface at y = 0.01, markings 0.012, sidewalk top 0.15.
- `addIntersection({ x, z, lanesPerDir = 2, laneWidth = 3.5, sidewalk = 5, arms: { n, s, e, w } })` — a 4-way
  junction of two perpendicular roads (N–S and E–W) centred at (x, z). `arms` gives each arm's length in metres
  from the centre (0 = no arm). Draws the junction box, arms (with lane markings), stop lines, zebra crosswalks
  on every arm just outside the box, rounded corner curbs (radius ≈ 4 m) and corner sidewalk areas.
  Exact layout (lanesPerDir 2, laneWidth 3.5): carriageway half-width 7 m; crosswalk zebra spans 8.5 … 12.5 m
  from the centre on each arm; stop line at 13.5 m; sidewalk from 7 m to 12 m off the road axis.
  Also return/attach nothing else — signals are placed by the integrator.
- `addPath(points, width)` — paved footpath polyline (for parks/campus), flush with grass (y = 0.03).
- Extra factories: `createStreetlight()` (pole + arm + lamp head, ~9 m, faces +Z), `createBench()`,
  `createBusStop()` (glass shelter, bench, route sign), `createFence({ length, height = 2.2, gaps = [] })`
  (decorative campus fence along local +X from 0 to length, with brick/stone pillars every 3 m and metal
  bars between; `gaps` = [[from, to], …] in metres are demolished sections: missing bars, broken pillar
  stubs, rubble pieces on the ground), `createGround({ size = 6000 })` (base ground plane: dry-grass/earth
  colour with subtle procedural variation, top at y = 0).
- `demo()`: an intersection with arms 60 m, a road with a median, a fresh road, a path, street props, and a fence
  with one demolished gap.

### src/devices.js  (budget: 4 signal poles + props ≤ 60 draw calls)
- `createSignalPole({ armLength = 8 })` → `{ group, setState(state), setPedState(state), cameraMount, regulatorMount,
  smartCam, update(t, dt) }`
  - Pole origin at its base. Vertical galvanised pole ~6.5 m with a horizontal mast arm at ~6 m extending along
    local −X by `armLength`; a 3-aspect vehicle signal head (red / yellow / green with visors and backplate with
    white border) hangs from the arm end region and another is mounted on the pole at ~3 m; both face +Z.
    A pedestrian signal (red standing man / green walking man) on the pole at ~2.6 m facing local −X.
  - `setState('red' | 'yellow' | 'green' | 'redyellow')`: lit lens emissive bright, unlit lenses dark.
  - On top of the pole, a small round platform at ~7.6 m: `regulatorMount` = Object3D on that platform
    (the integrator stands a traffic officer there — symbolic "regulator built into the camera").
  - `smartCam` = the SmartCross camera (see createSmartCam) already mounted on a bracket on the pole at ~7.0 m,
    facing +Z and tilted ~12° down. `cameraMount` = the bracket Object3D.
- `createSmartCam()` → `{ group, lens, setActive(on), update(t, dt) }` — a sleek AI traffic camera: white/graphite
  housing with rounded edges, sun shield, large glass lens with depth (inner rings), a thin status LED strip in
  signal-green that pulses when active, a small "SmartCross" wordmark (CanvasTexture), mounting knuckle.
  Faces +Z; `lens` = Object3D at the lens centre looking along +Z (used to place the presentation camera "inside").
- `createEdgeBox()` → `{ group }` — roadside edge-computer cabinet (~1.4 m tall) for the pole base: grey steel
  cabinet with door seams, vents, lock, small status LEDs, "SmartCross Edge" label, concrete footing.
- `createCameraPost()` → `{ group, smartCam }` — a slim ~2.4 m post on a small base with a SmartCross camera on top
  (for the finale, next to a person on the pavement).
- `createRoadWorks({ length = 24, width = 7 })` → `{ group, workerSpot, dustOrigin, update(t, dt) }` — a road-repair
  site laid out along local +X from 0 to length, across local Z from −width/2 to width/2: red-white barriers,
  traffic cones, «ДОРОЖНЫЕ РАБОТЫ» sign, broken asphalt slabs, dug pit with earth, gravel/dirt piles, a detailed
  yellow excavator (tracks, cab with windows, boom, stick, bucket — `update` slowly moves the arm), a compressor
  with hose. `workerSpot` = Object3D on the ground where the worker stands (facing +Z, at the pit edge);
  `dustOrigin` = Object3D where jackhammer dust should spawn.
- `createDust()` → `{ group, burst(position, amount), update(dt) }` — soft dust/debris particles (sprites with a
  procedural soft-circle CanvasTexture + a few small rock chunks) that rise, spread, fade.
- `createHonkWaves({ color = 0xffd34d })` → `{ group, update(t) }` — animated sound-wave arcs (3–4 nested partial
  rings that expand from the origin toward +Z/up and fade, looping ~1.2 s) to show a car horn honking; plus a small
  "БИП!" CanvasTexture sprite that pops. Unlit, transparent, no shadows.
- `demo()`: a pole set to green with its smartCam, edge box, camera post, road-works site with dust and honk waves.

### src/logo.js  (budget: ≤ 10 draw calls)
- `createStarLogo()` → `{ group, update(t, dt) }` — the "Lone Stars" team logo: a five-pointed star, volumetric,
  smooth and softly rounded (puffy/pillowy edges and tips — e.g. a star shape with rounded tips extruded with a
  generous multi-segment bevel, or a SDF-like inflated mesh), ~6 m across, centred at the origin facing +Z.
  Premium material (e.g. MeshPhysicalMaterial with clearcoat, warm gold or a tasteful brand colour with subtle
  iridescence/sheen). `update` = an aesthetic loop: slow floating bob, gentle tilt/turn so reflections slide over
  the surface, a soft "breathing" scale, plus a few orbiting sparkle points. Must look great against a blue sky.
- `demo()`: the logo.
