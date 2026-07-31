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

/**
 * Collapse an occt hierarchy node into the assembly tree the BOM importer wants.
 *
 * A STEP file repeats an instanced part once per placement, so four identical screws are
 * four sibling nodes. A BOM wants one line with quantity 4 — so siblings that share a name
 * AND the same subtree shape are folded into a single node with `instances` summed.
 */
function toAssemblyNode(node) {
  const children = (node.children ?? []).map(toAssemblyNode);
  const collapsed = [];
  for (const child of children) {
    // Shape is compared structurally: same name, same instance count, same descendants.
    const twin = collapsed.find(
      (c) => c.name === child.name && JSON.stringify(c.children) === JSON.stringify(child.children)
    );
    if (twin) twin.instances += child.instances;
    else collapsed.push(child);
  }
  // The kernel names anonymous aggregates of free shapes "COMPOUND" — that is a kernel
  // artifact, not a product, so it is reported the same as an unnamed one.
  const raw = typeof node.name === 'string' ? node.name.trim() : '';
  const name = raw === '' || raw === 'COMPOUND' ? 'Unnamed' : raw;
  return { name, instances: 1, children: collapsed };
}

const countNodes = (node) => 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
const depthOf = (node) =>
  node.children.length === 0 ? 1 : 1 + Math.max(...node.children.map(depthOf));

app.post('/assembly', async (req, res) => {
  const { storagePath, fileName } = req.body ?? {};
  if (typeof storagePath !== 'string' || typeof fileName !== 'string') {
    res.status(400).json({ error: 'storagePath and fileName are required' });
    return;
  }
  const ext = extensionOf(fileName);
  if (!SUPPORTED.has(ext)) {
    res.json({ status: 'SKIPPED', reason: `.${ext || 'unknown'} is not a readable CAD format` });
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

    if (!result.success || !result.root) {
      res.json({ status: 'FAILED', error: 'The CAD kernel could not read this file' });
      return;
    }

    let root = toAssemblyNode(result.root);
    // occt wraps the real product in an anonymous root; unwrap it.
    while (root.name === 'Unnamed' && root.children.length === 1) root = root.children[0];

    console.log(`assembly ${fileName}: ${countNodes(root)} nodes, depth ${depthOf(root)}`);
    res.json({ status: 'DONE', root, nodeCount: countNodes(root), maxDepth: depthOf(root) });
  } catch (err) {
    console.error(`assembly read failed for ${fileName}:`, err);
    res.json({ status: 'FAILED', error: (err?.message || 'Assembly read failed').slice(0, 400) });
  }
});

app.listen(PORT, () => {
  console.log(`TurboPLM CAD service listening on :${PORT} (uploads: ${UPLOAD_DIR})`);
});
