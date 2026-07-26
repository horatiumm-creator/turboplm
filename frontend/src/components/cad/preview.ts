/** Preview-kind detection shared by the (lazy-loaded) CadViewer and its call sites. */

export type PreviewKind = 'model3d' | 'pdf' | 'image' | 'unsupported';

const MODEL_EXTENSIONS = new Set([
  'step',
  'stp',
  'iges',
  'igs',
  'brep',
  'brp',
  'stl',
  'glb',
  'gltf',
  'obj',
  '3mf',
]);

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp']);

export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
}

export function previewKind(fileName: string): PreviewKind {
  const ext = fileExtension(fileName);
  if (MODEL_EXTENSIONS.has(ext)) return 'model3d';
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return 'unsupported';
}

export function isPreviewable(fileName: string): boolean {
  return previewKind(fileName) !== 'unsupported';
}
