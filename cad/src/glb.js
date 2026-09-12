/**
 * Minimal binary glTF (.glb) writer.
 *
 * Takes the mesh set produced by the OpenCascade importer and packs it into a
 * single-buffer GLB: one primitive per mesh, interleaved nothing, indices as
 * uint32. Enough for a web viewer to load a converted STEP/IGES/BREP instantly
 * without running the CAD kernel in the browser.
 */

const FLOAT = 5126;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

const pad4 = (n) => (n + 3) & ~3;

export function meshesToGlb(meshes) {
  const chunks = [];
  let offset = 0;
  const bufferViews = [];
  const accessors = [];
  const materials = [];
  const gltfMeshes = [];
  const nodes = [];

  const overall = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
  let triangleCount = 0;

  const pushView = (buf, target) => {
    const byteOffset = offset;
    chunks.push(buf);
    offset += buf.byteLength;
    const padding = pad4(offset) - offset;
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding));
      offset += padding;
    }
    bufferViews.push({ buffer: 0, byteOffset, byteLength: buf.byteLength, target });
    return bufferViews.length - 1;
  };

  for (const mesh of meshes) {
    const positions = Float32Array.from(mesh.attributes.position.array);
    const indices = Uint32Array.from(mesh.index.array);
    const normals = mesh.attributes.normal
      ? Float32Array.from(mesh.attributes.normal.array)
      : null;
    if (positions.length === 0 || indices.length === 0) continue;

    triangleCount += indices.length / 3;

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const v = positions[i + axis];
        if (v < min[axis]) min[axis] = v;
        if (v > max[axis]) max[axis] = v;
      }
    }
    for (let axis = 0; axis < 3; axis++) {
      if (min[axis] < overall.min[axis]) overall.min[axis] = min[axis];
      if (max[axis] > overall.max[axis]) overall.max[axis] = max[axis];
    }

    const posView = pushView(Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength), ARRAY_BUFFER);
    accessors.push({
      bufferView: posView,
      componentType: FLOAT,
      count: positions.length / 3,
      type: 'VEC3',
      min,
      max,
    });
    const posAccessor = accessors.length - 1;

    let normalAccessor = null;
    if (normals && normals.length === positions.length) {
      const view = pushView(Buffer.from(normals.buffer, normals.byteOffset, normals.byteLength), ARRAY_BUFFER);
      accessors.push({
        bufferView: view,
        componentType: FLOAT,
        count: normals.length / 3,
        type: 'VEC3',
      });
      normalAccessor = accessors.length - 1;
    }

    const idxView = pushView(
      Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength),
      ELEMENT_ARRAY_BUFFER
    );
    accessors.push({
      bufferView: idxView,
      componentType: UNSIGNED_INT,
      count: indices.length,
      type: 'SCALAR',
    });
    const idxAccessor = accessors.length - 1;

    const color = Array.isArray(mesh.color) && mesh.color.length >= 3 ? mesh.color : [0.54, 0.64, 0.78];
    materials.push({
      name: `${mesh.name || 'part'}-material`,
      pbrMetallicRoughness: {
        baseColorFactor: [color[0], color[1], color[2], 1],
        metallicFactor: 0.1,
        roughnessFactor: 0.65,
      },
      doubleSided: true,
    });

    const attributes = { POSITION: posAccessor };
    if (normalAccessor !== null) attributes.NORMAL = normalAccessor;
    gltfMeshes.push({
      name: mesh.name || `mesh-${gltfMeshes.length}`,
      primitives: [{ attributes, indices: idxAccessor, material: materials.length - 1 }],
    });
    nodes.push({ mesh: gltfMeshes.length - 1 });
  }

  if (gltfMeshes.length === 0) throw new Error('No renderable geometry in this file');

  const binary = Buffer.concat(chunks);
  const gltf = {
    asset: { version: '2.0', generator: 'TurboPLM CAD service' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: gltfMeshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binary.byteLength }],
  };

  const jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPadded = Buffer.concat([jsonBuf, Buffer.alloc(pad4(jsonBuf.length) - jsonBuf.length, 0x20)]);
  const binPadded = Buffer.concat([binary, Buffer.alloc(pad4(binary.length) - binary.length, 0)]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binPadded.length, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonPadded.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binPadded.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4); // 'BIN'

  return {
    glb: Buffer.concat([header, jsonHeader, jsonPadded, binHeader, binPadded]),
    triangleCount,
    boundingBox: {
      min: overall.min.map((v) => Number(v.toFixed(4))),
      max: overall.max.map((v) => Number(v.toFixed(4))),
      size: overall.max.map((v, i) => Number((v - overall.min[i]).toFixed(4))),
    },
  };
}
