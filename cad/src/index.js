/**
 * TurboPLM CAD conversion service.
 *
 * Runs the OpenCascade kernel (WASM) out of the API process so a large STEP file
 * cannot block request handling. It reads the uploaded file from the shared
 * uploads volume, tessellates it, and writes a .glb derivative next to it so the
 * web viewer can load heavy assemblies instantly without running the kernel in
 * the browser.
 *
 * Native CATIA / SolidWorks / NX files are proprietary and cannot be decoded
 * here — those are stored as-is and reported as unsupported.
 */
import fs from 'fs/promises';
import path from 'path';
import express from 'express';
import occtimportjs from 'occt-import-js';
import { meshesToGlb } from './glb.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads';
const PORT = Number(process.env.PORT || 4100);
const SUPPORTED = new Set(['step', 'stp', 'iges', 'igs', 'brep', 'brp']);

let occtPromise = null;
const getOcct = () => {
  if (!occtPromise) occtPromise = occtimportjs();
  return occtPromise;
};

const extensionOf = (name) => {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
};

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, formats: [...SUPPORTED] }));

app.post('/convert', async (req, res) => {
  const { storagePath, fileName } = req.body ?? {};
  if (typeof storagePath !== 'string' || typeof fileName !== 'string') {
    res.status(400).json({ error: 'storagePath and fileName are required' });
    return;
  }
  const ext = extensionOf(fileName);
  if (!SUPPORTED.has(ext)) {
    res.json({ status: 'SKIPPED', reason: `.${ext || 'unknown'} is not a convertible CAD format` });
    return;
  }

  const source = path.join(UPLOAD_DIR, path.basename(storagePath));
  try {
    const content = new Uint8Array(await fs.readFile(source));
    const occt = await getOcct();
    const result =
      ext === 'step' || ext === 'stp'
        ? occt.ReadStepFile(content, null)
        : ext === 'brep' || ext === 'brp'
          ? occt.ReadBrepFile(content, null)
          : occt.ReadIgesFile(content, null);

    if (!result.success || !Array.isArray(result.meshes) || result.meshes.length === 0) {
      res.json({ status: 'FAILED', error: 'The CAD kernel could not read this file' });
      return;
    }

    const { glb, triangleCount, boundingBox } = meshesToGlb(result.meshes);
    const glbName = `${path.basename(storagePath)}.glb`;
    await fs.writeFile(path.join(UPLOAD_DIR, glbName), glb);

    console.log(`converted ${fileName}: ${triangleCount} triangles -> ${glbName}`);
    res.json({
      status: 'DONE',
      glbPath: glbName,
      triangleCount,
      boundingBox,
      sizeBytes: glb.byteLength,
    });
  } catch (err) {
    console.error(`conversion failed for ${fileName}:`, err);
    res.json({ status: 'FAILED', error: (err?.message || 'Conversion failed').slice(0, 400) });
  }
});

app.listen(PORT, () => {
  console.log(`TurboPLM CAD service listening on :${PORT} (uploads: ${UPLOAD_DIR})`);
});
