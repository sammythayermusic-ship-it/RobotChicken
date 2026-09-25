import {
  FramebufferTexture, Mesh, OrthographicCamera, PlaneGeometry, Scene, ShaderMaterial, Vector2, type WebGLRenderer,
} from "three";

/**
 * KO chromatic-aberration pulse + white flash + vignette. Copies the already
 * tone-mapped frame into a texture and redraws it through one full-screen
 * quad: it costs GPU time only during the ~0.6 s pulse, so phones pay nothing
 * the rest of the match (a post-processing composer would cost every frame).
 */
export class KoPulse {
  private readonly scene = new Scene();
  private readonly cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mat: ShaderMaterial;
  private fb: FramebufferTexture | null = null;
  private readonly size = new Vector2();
  private t = 1;
  private readonly duration = 0.6;

  constructor() {
    this.mat = new ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: { tScene: { value: null }, uAmt: { value: 0 }, uFlash: { value: 0 }, uVig: { value: 0 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene; uniform float uAmt, uFlash, uVig; varying vec2 vUv;
        void main(){
          vec2 d = vUv - 0.5; float r2 = dot(d, d); vec2 o = d * r2 * uAmt;
          vec3 c = vec3(texture2D(tScene, vUv + o).r, texture2D(tScene, vUv).g, texture2D(tScene, vUv - o).b);
          c = mix(c, vec3(1.0), uFlash);
          c *= 1.0 - uVig * r2 * 2.0;
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    const quad = new Mesh(new PlaneGeometry(2, 2), this.mat);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  trigger(): void {
    this.t = 0;
  }

  advance(dt: number): void {
    if (this.t < 1) this.t = Math.min(1, this.t + dt / this.duration);
  }

  get active(): boolean {
    return this.t < 1;
  }

  /** Call right after the main scene render. */
  apply(renderer: WebGLRenderer, force = false): void {
    if (!this.active && !force) return;
    renderer.getDrawingBufferSize(this.size);
    if (!this.fb || this.fb.image.width !== this.size.x || this.fb.image.height !== this.size.y) {
      this.fb?.dispose();
      this.fb = new FramebufferTexture(this.size.x, this.size.y);
      this.mat.uniforms.tScene!.value = this.fb;
    }
    const env = force ? 0.5 : Math.sin(this.t * Math.PI); // 0 -> 1 -> 0
    this.mat.uniforms.uAmt!.value = 0.15 * env;
    this.mat.uniforms.uFlash!.value = !force && this.t < 0.06 ? 0.55 : 0;
    this.mat.uniforms.uVig!.value = 0.6 * env;
    renderer.copyFramebufferToTexture(this.fb);
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.scene, this.cam);
    renderer.autoClear = auto;
  }

  dispose(): void {
    this.fb?.dispose();
    this.mat.dispose();
  }
}
