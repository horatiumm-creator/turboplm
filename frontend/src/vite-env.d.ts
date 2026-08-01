/// <reference types="vite/client" />

/**
 * Build-time configuration this app reads, declared so `import.meta.env` is typed rather
 * than `any`.
 *
 * Both are set ONLY on the public demo deployment, as Docker build args. Everywhere else
 * they are absent and the "Explore the demo" button on the sign-in page does not render —
 * which is why they are optional here. A required type would be a lie about every other
 * build, and would push the mistake to runtime.
 */
interface ImportMetaEnv {
  /** The shared read-only VIEWER account on the demo instance. */
  readonly VITE_DEMO_EMAIL?: string;
  /**
   * Its password. Deliberately shipped in the bundle: the account cannot write anything
   * (`requireWriteRole` refuses every mutation from a VIEWER) and the entire point is that
   * any visitor may use it. Never put a real credential here.
   */
  readonly VITE_DEMO_PASSWORD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
