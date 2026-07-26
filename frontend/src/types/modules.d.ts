declare module 'occt-import-js' {
  interface OcctMeshAttributes {
    position: { array: number[] };
    normal?: { array: number[] };
  }
  interface OcctMesh {
    name: string;
    attributes: OcctMeshAttributes;
    index: { array: number[] };
    color?: [number, number, number];
  }
  interface OcctResult {
    success: boolean;
    meshes: OcctMesh[];
  }
  interface OcctModule {
    ReadStepFile: (content: Uint8Array, params: unknown) => OcctResult;
    ReadIgesFile: (content: Uint8Array, params: unknown) => OcctResult;
    ReadBrepFile: (content: Uint8Array, params: unknown) => OcctResult;
  }
  const init: (options?: { locateFile?: (file: string) => string }) => Promise<OcctModule>;
  export default init;
}

declare module '*.wasm?url' {
  const url: string;
  export default url;
}
