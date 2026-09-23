// Types for the two untyped CommonJS packages the asset tools use.

declare module "draco3dgltf" {
  /** Emscripten module factories; the result is passed to gltf-transform's registerDependencies. */
  export function createDecoderModule(options?: object): Promise<unknown>;
  export function createEncoderModule(options?: object): Promise<unknown>;
  const draco3d: { createDecoderModule: typeof createDecoderModule; createEncoderModule: typeof createEncoderModule };
  export default draco3d;
}

declare module "gltf-validator" {
  export interface ValidationMessage {
    code: string;
    message: string;
    /** 0 error, 1 warning, 2 info, 3 hint */
    severity: number;
    pointer?: string;
    offset?: number;
  }
  export interface ValidationReport {
    issues: {
      numErrors: number;
      numWarnings: number;
      numInfos: number;
      numHints: number;
      messages: ValidationMessage[];
      truncated: boolean;
    };
    info?: Record<string, unknown>;
  }
  export interface ValidationOptions {
    uri?: string;
    format?: "glb" | "gltf";
    maxIssues?: number;
    ignoredIssues?: string[];
    severityOverrides?: Record<string, number>;
    externalResourceFunction?: (uri: string) => Promise<Uint8Array>;
  }
  export function validateBytes(data: Uint8Array, options?: ValidationOptions): Promise<ValidationReport>;
  export function version(): string;
  const validator: { validateBytes: typeof validateBytes; version: typeof version };
  export default validator;
}
