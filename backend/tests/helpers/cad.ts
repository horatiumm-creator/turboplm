/**
 * CAD sidecar stub.
 *
 * The `cad` service is a separate container running an OCCT kernel; CI has no such
 * service and no real STEP files. `fetchAssemblyFromKernel` is the single network call in
 * that path, so stubbing `fetch` exercises everything above it — extraction, persistence
 * as a cBOM, name-to-part resolution — without a sidecar. Any unstubbed call fails loudly
 * rather than silently reaching a real host.
 */
import { vi } from 'vitest';
import type { CadTree } from './factories';

export interface KernelAssemblyResponse {
  status: 'DONE' | 'SKIPPED' | 'FAILED';
  root?: unknown;
  nodeCount?: number;
  maxDepth?: number;
  reason?: string;
  error?: string;
}

/** CadTree → the shape the sidecar returns (every node carries an explicit instance count). */
export function toKernelTree(tree: CadTree): {
  name: string;
  instances: number;
  children: ReturnType<typeof toKernelTree>[];
} {
  return {
    name: tree.name,
    instances: tree.instances ?? 1,
    children: (tree.children ?? []).map(toKernelTree),
  };
}

function countNodes(tree: CadTree): number {
  return 1 + (tree.children ?? []).reduce((sum, child) => sum + countNodes(child), 0);
}

function treeDepth(tree: CadTree): number {
  return (tree.children ?? []).reduce((max, child) => Math.max(max, 1 + treeDepth(child)), 0);
}

export interface CadStub {
  /** One entry per POST the app made to the sidecar. */
  calls: { url: string; body: unknown }[];
}

/** Install a fetch stub answering POST /assembly with a fixed envelope. */
export function stubCadKernel(response: KernelAssemblyResponse): CadStub {
  const stub: CadStub = { calls: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      stub.calls.push({
        url,
        body: init?.body ? (JSON.parse(init.body) as unknown) : null,
      });
      return {
        ok: true,
        status: 200,
        json: async () => response,
        text: async () => JSON.stringify(response),
      };
    })
  );
  return stub;
}

/** The common case: the kernel reads the file and returns this tree. */
export function stubCadKernelWithTree(tree: CadTree): CadStub {
  return stubCadKernel({
    status: 'DONE',
    root: toKernelTree(tree),
    nodeCount: countNodes(tree),
    maxDepth: treeDepth(tree),
  });
}

/** Simulate the sidecar being unreachable, the way CI would see it unstubbed. */
export function stubCadKernelUnreachable(): CadStub {
  const stub: CadStub = { calls: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      stub.calls.push({ url: String(input), body: null });
      throw new Error('fetch failed');
    })
  );
  return stub;
}
