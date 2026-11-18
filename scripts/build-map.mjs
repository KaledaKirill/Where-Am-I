import { copyFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';

const source = new URL('../src/map/client/', import.meta.url);
const output = new URL('../dist/map-ui/', import.meta.url);
await build({
  entryPoints: [fileURLToPath(new URL('app.ts', source))],
  outdir: fileURLToPath(output),
  bundle: true,
  minify: true,
  target: ['safari16', 'chrome110', 'firefox115'],
  format: 'esm',
});
await copyFile(new URL('index.html', source), new URL('index.html', output));
await copyFile(fileURLToPath(import.meta.resolve('maplibre-gl/dist/maplibre-gl-worker.mjs')), new URL('maplibre-gl-worker.mjs', output));
