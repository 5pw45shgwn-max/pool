import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = resolve(projectRoot, "public/index.html");
const outputPath = resolve(projectRoot, "shared/physics.mjs");
const html = await readFile(htmlPath, "utf8");
const startMarker = "/* CHRIS_SHARED_PHYSICS_BEGIN */";
const endMarker = "/* CHRIS_SHARED_PHYSICS_END */";
const start = html.indexOf(startMarker);
const end = html.indexOf(endMarker);

if (start < 0 || end <= start) {
  throw new Error("Could not find the shared physics markers in public/index.html");
}

const sourceStart = start + startMarker.length;
const inlineSource = html.slice(sourceStart, end).trim();
const moduleSource = `${inlineSource}\n\nexport {\n  Qr as FIXED_TIMESTEP,\n  Nn as POCKETS,\n  Ci as RAIL_SEGMENTS,\n  Kr as BilliardsPhysics,\n  $i as BilliardsRules,\n  xl as rackBalls,\n  nn as createBall,\n};\n`;

await writeFile(outputPath, moduleSource);
console.log(`Generated ${outputPath}`);
