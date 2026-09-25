import { BufferAttribute, BufferGeometry, Matrix3, Matrix4, Vector3 } from "three";

/** Per-vertex bake callback: world position + world normal in, attribute values out. */
export type Shade<K extends string> = (p: Vector3, n: Vector3, out: Record<K, Float32Array>) => void;

/**
 * Stamps transformed copies of primitive geometries into ONE geometry, calling
 * a bake function per vertex to fill extra attributes (albedo, baked light,
 * fire weights...). One builder per material = one draw call per group, the
 * "baked lightmap" look with zero textures (cf. soltendogs mergeCopies).
 * Runs once at load; nothing here is on a per-frame path.
 */
export class GeoBuilder<K extends string> {
  private readonly sizes: Record<K, number>;
  private readonly keys: K[];
  private readonly out: Record<K, Float32Array>;
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly extra: Record<K, number[]>;
  private readonly idx: number[] = [];
  private readonly p = new Vector3();
  private readonly n = new Vector3();
  private readonly nm = new Matrix3();

  constructor(sizes: Record<K, number>) {
    this.sizes = sizes;
    this.keys = Object.keys(sizes) as K[];
    this.out = {} as Record<K, Float32Array>;
    this.extra = {} as Record<K, number[]>;
    for (const k of this.keys) {
      this.out[k] = new Float32Array(sizes[k]);
      this.extra[k] = [];
    }
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  /** Append `src` transformed by `m`. `src` is left untouched (the caller may reuse it). */
  add(src: BufferGeometry, m: Matrix4, shade: Shade<K>): void {
    const pa = src.getAttribute("position");
    const na = src.getAttribute("normal");
    if (!pa || !na) throw new Error("GeoBuilder.add: geometry needs position and normal");
    this.nm.getNormalMatrix(m);
    const base = this.vertexCount;
    for (let i = 0; i < pa.count; i++) {
      this.p.fromBufferAttribute(pa, i).applyMatrix4(m);
      this.n.fromBufferAttribute(na, i).applyMatrix3(this.nm).normalize();
      this.pos.push(this.p.x, this.p.y, this.p.z);
      this.nor.push(this.n.x, this.n.y, this.n.z);
      for (const k of this.keys) this.out[k].fill(0);
      shade(this.p, this.n, this.out);
      for (const k of this.keys) {
        const o = this.out[k];
        const dst = this.extra[k];
        for (let j = 0; j < o.length; j++) dst.push(o[j] as number);
      }
    }
    // A negative-determinant transform (a mirror) flips winding; keep faces front-facing.
    const flip = m.determinant() < 0;
    const index = src.getIndex();
    const tri = (a: number, b: number, c: number) => (flip ? this.idx.push(base + a, base + c, base + b) : this.idx.push(base + a, base + b, base + c));
    if (index) for (let i = 0; i < index.count; i += 3) tri(index.getX(i), index.getX(i + 1), index.getX(i + 2));
    else for (let i = 0; i < pa.count; i += 3) tri(i, i + 1, i + 2);
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute("normal", new BufferAttribute(new Float32Array(this.nor), 3));
    for (const k of this.keys) g.setAttribute(k, new BufferAttribute(new Float32Array(this.extra[k]), this.sizes[k]));
    const n = this.vertexCount;
    g.setIndex(new BufferAttribute(n > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Flat-shaded copy (per-face normals) of an indexed primitive: hard edges for boxy junk. */
export function faceted(g: BufferGeometry): BufferGeometry {
  const flat = g.index ? g.toNonIndexed() : g.clone();
  flat.deleteAttribute("normal");
  flat.computeVertexNormals();
  return flat;
}
