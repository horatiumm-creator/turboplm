import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Space, Spin, Typography } from 'antd';
import { BorderOutlined, CompressOutlined } from '@ant-design/icons';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { fileExtension, previewKind } from './preview';

const DEFAULT_COLOR = 0x8aa2c8;
const BACKGROUND = 0xf2f4f7;

interface CadViewerProps {
  fileUrl: string;
  fileName: string;
  height?: number;
}

async function loadOcctGroup(ext: string, buffer: ArrayBuffer): Promise<THREE.Group> {
  const [{ default: occtInit }, { default: wasmUrl }] = await Promise.all([
    import('occt-import-js'),
    import('occt-import-js/dist/occt-import-js.wasm?url'),
  ]);
  const occt = await occtInit({ locateFile: () => wasmUrl });
  const content = new Uint8Array(buffer);
  const result =
    ext === 'step' || ext === 'stp'
      ? occt.ReadStepFile(content, null)
      : ext === 'brep' || ext === 'brp'
        ? occt.ReadBrepFile(content, null)
        : occt.ReadIgesFile(content, null);
  if (!result.success || result.meshes.length === 0) {
    throw new Error('The CAD kernel could not read this file — is it a valid STEP/IGES/BREP export?');
  }
  const group = new THREE.Group();
  for (const mesh of result.meshes) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(mesh.attributes.position.array, 3)
    );
    if (mesh.attributes.normal) {
      geometry.setAttribute(
        'normal',
        new THREE.Float32BufferAttribute(mesh.attributes.normal.array, 3)
      );
    }
    geometry.setIndex(new THREE.Uint32BufferAttribute(mesh.index.array, 1));
    if (!mesh.attributes.normal) geometry.computeVertexNormals();
    const color = mesh.color
      ? new THREE.Color(mesh.color[0], mesh.color[1], mesh.color[2])
      : new THREE.Color(DEFAULT_COLOR);
    const material = new THREE.MeshStandardMaterial({
      color,
      metalness: 0.1,
      roughness: 0.65,
      side: THREE.DoubleSide,
    });
    group.add(new THREE.Mesh(geometry, material));
  }
  return group;
}

async function loadModel(ext: string, fileUrl: string): Promise<THREE.Object3D> {
  if (ext === 'step' || ext === 'stp' || ext === 'iges' || ext === 'igs' || ext === 'brep' || ext === 'brp') {
    const res = await fetch(fileUrl, { credentials: 'include' });
    if (!res.ok) throw new Error(`Could not load the file (HTTP ${res.status})`);
    return loadOcctGroup(ext, await res.arrayBuffer());
  }
  if (ext === 'stl') {
    const res = await fetch(fileUrl, { credentials: 'include' });
    if (!res.ok) throw new Error(`Could not load the file (HTTP ${res.status})`);
    const geometry = new STLLoader().parse(await res.arrayBuffer());
    if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals();
    return new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: DEFAULT_COLOR,
        metalness: 0.1,
        roughness: 0.65,
        side: THREE.DoubleSide,
      })
    );
  }
  if (ext === 'glb' || ext === 'gltf') {
    const gltf = await new GLTFLoader().loadAsync(fileUrl);
    return gltf.scene;
  }
  if (ext === 'obj') {
    const res = await fetch(fileUrl, { credentials: 'include' });
    if (!res.ok) throw new Error(`Could not load the file (HTTP ${res.status})`);
    return new OBJLoader().parse(await res.text());
  }
  if (ext === '3mf') {
    const res = await fetch(fileUrl, { credentials: 'include' });
    if (!res.ok) throw new Error(`Could not load the file (HTTP ${res.status})`);
    return new ThreeMFLoader().parse(await res.arrayBuffer());
  }
  throw new Error(`Unsupported model format: .${ext}`);
}

function Model3dViewer({ fileUrl, fileName, height = 480 }: CadViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const modelRef = useRef<THREE.Object3D | null>(null);
  const fitRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let frame = 0;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BACKGROUND);
    const camera = new THREE.PerspectiveCamera(
      45,
      container.clientWidth / Math.max(height, 1),
      0.01,
      10000
    );
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, height);
    container.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x777788, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(1, 1.4, 1);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-1, -0.4, -1);
    scene.add(fill);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    const fitToModel = (object: THREE.Object3D) => {
      const box = new THREE.Box3().setFromObject(object);
      if (box.isEmpty()) return;
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const radius = Math.max(size.x, size.y, size.z, 0.001);
      camera.near = radius / 100;
      camera.far = radius * 40;
      camera.position.copy(center).add(new THREE.Vector3(radius, radius * 0.8, radius));
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
      const grid = new THREE.GridHelper(radius * 3, 20, 0xbfc6d1, 0xe3e7ee);
      grid.position.set(center.x, box.min.y, center.z);
      grid.name = '__grid';
      const existing = scene.getObjectByName('__grid');
      if (existing) scene.remove(existing);
      scene.add(grid);
    };

    const animate = () => {
      frame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const observer = new ResizeObserver(() => {
      const width = container.clientWidth;
      if (width <= 0) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    });
    observer.observe(container);

    setLoading(true);
    setError(null);
    void loadModel(fileExtension(fileName), fileUrl)
      .then((object) => {
        if (disposed) return;
        scene.add(object);
        modelRef.current = object;
        fitRef.current = () => fitToModel(object);
        fitToModel(object);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (disposed) return;
        setError(err instanceof Error ? err.message : 'Could not display this file');
        setLoading(false);
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
          materials.forEach((m) => m.dispose());
        }
      });
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [fileUrl, fileName, height]);

  const toggleWireframe = useCallback(() => {
    const next = !wireframe;
    setWireframe(next);
    modelRef.current?.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        materials.forEach((m) => {
          if ('wireframe' in m) (m as THREE.MeshStandardMaterial).wireframe = next;
        });
      }
    });
  }, [wireframe]);

  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        <Button
          size="small"
          icon={<CompressOutlined />}
          onClick={() => fitRef.current?.()}
          disabled={loading || !!error}
        >
          Fit
        </Button>
        <Button
          size="small"
          icon={<BorderOutlined />}
          type={wireframe ? 'primary' : 'default'}
          onClick={toggleWireframe}
          disabled={loading || !!error}
        >
          Wireframe
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Drag to rotate · scroll to zoom · right-drag to pan
        </Typography.Text>
      </Space>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} />}
      <Spin spinning={loading} tip="Reading CAD geometry…">
        <div
          ref={containerRef}
          style={{ width: '100%', height, borderRadius: 8, overflow: 'hidden' }}
        />
      </Spin>
    </div>
  );
}

export default function CadViewer({ fileUrl, fileName, height = 480 }: CadViewerProps) {
  const kind = previewKind(fileName);

  if (kind === 'pdf') {
    return (
      <iframe
        title={fileName}
        src={fileUrl}
        style={{ width: '100%', height, border: '1px solid #e3e7ee', borderRadius: 8 }}
      />
    );
  }
  if (kind === 'image') {
    return (
      <div style={{ textAlign: 'center' }}>
        <img
          src={fileUrl}
          alt={fileName}
          style={{ maxWidth: '100%', maxHeight: height, borderRadius: 8 }}
        />
      </div>
    );
  }
  if (kind === 'model3d') {
    return <Model3dViewer fileUrl={fileUrl} fileName={fileName} height={height} />;
  }
  return (
    <Alert
      type="info"
      showIcon
      message="No preview available for this file type"
      description="Supported: STEP, IGES, BREP, STL, glTF/GLB, OBJ, 3MF, PDF and images. Export a neutral format (e.g. STEP) from CATIA / SolidWorks / NX to preview it here."
    />
  );
}
