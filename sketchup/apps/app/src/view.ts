import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import type { Aabb, MeshData, Vec3 } from "@apexus/geometry";
import {
  ancestorsThroughGroups,
  dragBox,
  dragDirection,
  drawnSolids,
  isDegenerate,
  isLassoPath,
  lassoDirection,
  selectByDrag,
  selectByLasso,
  type ScreenBox,
  type Session,
  type Solid,
  type SolidId,
} from "@apexus/engine";

/**
 * Renderer layer (ADR 0001). Holds no truth: every mesh here is derived from a
 * `Solid` and cached by `revision`, so the scene is rebuilt only when the
 * document actually changed.
 */

const UP: Vec3 = [0, 0, 1];

/** Points closer than this on screen are merged, so a still hand adds no noise. */
const LASSO_STEP = 6;

/**
 * True when a drag with the Select tool traces a lasso rather than a rectangle.
 *
 * SketchUp puts lasso and rectangle on the same drag and lets the modifier
 * decide, so a user who never learns the modifier never loses the behaviour they
 * had. Right button is the only free one here: Ctrl and Shift are already copy
 * and "add to selection" during a drag.
 */
export function isLassoDrag(button: number, tool: Tool): boolean {
  return tool === "select" && button === 2;
}

export type Tool =
  | "select"
  | "rectangle"
  | "pushpull"
  | "line"
  | "tape"
  | "dimension"
  | "followme"
  | "offset"
  | "move"
  | "rotate"
  | "circle"
  | "polygon"
  | "arc"
  | "rotatedRectangle"
  | "scale"
  | "paint"
  | "eraser";

export type PickHit =
  | { readonly kind: "ground"; readonly point: Vec3 }
  | { readonly kind: "solid"; readonly id: SolidId; readonly faceNormal: Vec3; readonly point: Vec3 }
  | { readonly kind: "gizmo" };

export interface ViewEvents {
  onPick(hit: PickHit, additive: boolean, copy?: boolean): void;
  onHover(point: Vec3 | null): void;
  /** A rectangle drag finished without hitting anything: ids the drag selected. */
  onMarquee(ids: readonly SolidId[], additive: boolean): void;
  /** Gizmo finished a drag: the object's new world matrix, column-major. */
  onGizmoCommit(id: SolidId, matrix: readonly number[]): void;
  /** A double-click on a solid: enter it if it is a group. */
  onEnter(id: SolidId): void;
}

interface CachedMesh {
  revision: number;
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  baseColor: THREE.Color;
}

export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  /**
   * The live camera. Orthographic until the user switches to perspective; both
   * types share every call site (`project`, `lookAt`, matrices), so the rest of
   * the file never asks which one it is holding.
   */
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly gizmo: TransformControls;
  readonly content = new THREE.Group();
  readonly grid: THREE.GridHelper;
  readonly axes: THREE.AxesHelper;
  /** The shadow-casting sun; `setShadows` toggles its shadow, not the light. */
  readonly solar: THREE.DirectionalLight;
  /** The shadow-catching floor. Visible only while shadows are on. */
  readonly ground: THREE.Mesh;

  #session: Session;
  #events: ViewEvents;
  #cache = new Map<SolidId, CachedMesh>();
  #frustum = new THREE.Frustum();
  #projScreen = new THREE.Matrix4();
  #raycaster = new THREE.Raycaster();
  #pointer = new THREE.Vector2();
  #dirty = true;
  #resizeObserver: ResizeObserver;
  #downAt: { x: number; y: number } | null = null;
  /** Screen points of an in-progress lasso; null when this drag is a rectangle. */
  #lasso: { x: number; y: number }[] | null = null;
  #gizmoStart: { id: SolidId; matrix: number[] } | null = null;
  #shift = false;
  #style: "shaded" | "hiddenLine" | "edges" = "shaded";
  /** X-ray lens over the current style; not a style of its own. */
  #xray = false;
  #shadows = true;
  #axesVisible = true;
  /** Live drag rectangle; created lazily so the overlay sits over the canvas. */
  #marqueeEl: HTMLElement | null = null;

  tool: Tool = "select";

  constructor(container: HTMLElement, session: Session, events: ViewEvents) {
    this.#session = session;
    this.#events = events;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color("#22262b");
    this.scene.fog = new THREE.Fog("#22262b", 6000, 16000);

    const size = container.getBoundingClientRect();
    const aspect = Math.max(size.width, 1) / Math.max(size.height, 1);
    const half = 400;
    this.camera = new THREE.OrthographicCamera(-half * aspect, half * aspect, half, -half, -20000, 40000);
    this.camera.up.set(...UP);
    this.camera.position.set(1200, -1400, 900);
    this.camera.lookAt(0, 0, 0);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.mouseButtons = {
      LEFT: null as unknown as THREE.MOUSE,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener("change", () => (this.#dirty = true));

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.85);
    this.gizmo.setSpace("world");
    this.gizmo.addEventListener("dragging-changed", (e) => {
      const dragging = (e as unknown as { value: boolean }).value;
      this.controls.enabled = !dragging;
      this.#onGizmoDragging(dragging);
    });
    this.scene.add(this.gizmo.getHelper());

    this.scene.add(this.content);
    const env = this.#buildEnvironment();
    this.grid = env.grid;
    this.axes = env.axes;
    this.solar = env.sun;
    this.ground = env.ground;
    this.#applySection();

    this.#resizeObserver = new ResizeObserver(() => this.#resize(container));
    this.#resizeObserver.observe(container);
    this.#resize(container);

    const dom = this.renderer.domElement;
    // The marquee lives beside the canvas inside the viewport, so it scrolls
    // and clips with it rather than floating over the whole window.
    const overlay = document.createElement("div");
    overlay.id = "marquee";
    overlay.hidden = true;
    // The rectangle must never swallow the pointer events that end the drag.
    overlay.addEventListener("pointerdown", (e) => e.stopPropagation());
    dom.parentElement?.append(overlay);
    this.#marqueeEl = overlay;
    dom.addEventListener("pointerdown", this.#onPointerDown);
    dom.addEventListener("dblclick", this.#onDoubleClick);
    // Window-level, so a drag that leaves the canvas still ends cleanly.
    window.addEventListener("pointerup", this.#onPointerUp);
    dom.addEventListener("pointermove", this.#onPointerMove);
    dom.addEventListener("contextmenu", (e) => e.preventDefault());

    window.addEventListener("keydown", this.#onKeyDown);
    window.addEventListener("keyup", this.#onKeyUp);
    window.addEventListener("blur", () => (this.#shift = false));
    this.#loop();
  }

  /* ------------------------------------------------------------ public API */

  setTool(tool: Tool): void {
    this.tool = tool;
    this.gizmo.enabled = tool === "select";
    this.renderer.domElement.style.cursor = tool === "select" ? "default" : "crosshair";
    this.#hideMarquee();
    this.#lasso = null;
    this.controls.enabled = true;
    this.#dirty = true;
  }

  /** Shift currently held; the tools use it as an axis lock. */
  get axisLocked(): boolean {
    return this.#shift;
  }

  invalidate(): void {
    this.#dirty = true;
  }

  /** mm per screen pixel at the orbit target; snapping uses it for screen-constant tolerance. */
  mmPerPixel(): number {
    const r = this.renderer.domElement.getBoundingClientRect();
    const px = Math.max(r.height, 1);
    const cam = this.camera;
    if (cam instanceof THREE.PerspectiveCamera) {
      // Height of the view frustum at the distance the user is orbiting around.
      const distance = cam.position.distanceTo(this.controls.target);
      return (2 * distance * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / px;
    }
    return (cam.top - cam.bottom) / cam.zoom / px;
  }

  zoomExtents(): void {
    const box = new THREE.Box3();
    for (const c of this.#cache.values()) box.expandByObject(c.mesh);
    if (box.isEmpty()) {
      const env = this.#session.document.envelope;
      if (env) box.set(new THREE.Vector3(...env.min), new THREE.Vector3(...env.max));
      else box.setFromCenterAndSize(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1000, 1000, 1000));
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 + 300;
    this.controls.target.copy(center);
    this.camera.zoom = 1;
    const aspect = Math.max(this.renderer.domElement.clientWidth, 1) / Math.max(this.renderer.domElement.clientHeight, 1);
    const halfH = radius;
    const cam = this.camera;
    if (cam instanceof THREE.PerspectiveCamera) {
      // Pull the camera back far enough for a sphere of `radius` to fit the
      // narrower of the two half-angles.
      const vFov = THREE.MathUtils.degToRad(cam.fov);
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
      const distance = radius / Math.sin(Math.min(vFov, hFov) / 2);
      const away = cam.position.clone().sub(center).normalize();
      cam.position.copy(center).addScaledVector(away, distance);
    } else {
      cam.top = halfH;
      cam.bottom = -halfH;
      cam.left = -halfH * aspect;
      cam.right = halfH * aspect;
    }
    cam.far = Math.max(radius * 40 + cam.position.distanceTo(center), 40000);
    cam.updateProjectionMatrix();
    this.controls.update();
    this.#dirty = true;
  }

  /**
   * Orthographic (SketchUp's default, and the only honest view for measuring)
   * or perspective (how the eye reads a finished model). The orbit target and
   * direction are kept, so switching is a lens change, not a camera move.
   */
  setProjection(kind: "ortho" | "perspective"): void {
    const old = this.camera;
    const r = this.renderer.domElement.getBoundingClientRect();
    const aspect = Math.max(r.width, 1) / Math.max(r.height, 1);
    const position = old.position.clone();
    const target = this.controls.target.clone();
    let next: THREE.OrthographicCamera | THREE.PerspectiveCamera;
    if (kind === "perspective") {
      // Keep the same size at the orbit target: distance * tan(fov/2) = halfH.
      const halfH = old instanceof THREE.PerspectiveCamera ? (old.position.distanceTo(target) * Math.tan(THREE.MathUtils.degToRad(old.fov / 2)) / old.zoom) : (old.top - old.bottom) / 2 / old.zoom;
      const distance = halfH / Math.tan(THREE.MathUtils.degToRad(35 / 2));
      const away = position.clone().sub(target).normalize();
      position.copy(target).addScaledVector(away, distance);
      const cam = new THREE.PerspectiveCamera(35, aspect, Math.max(distance / 1000, 1), distance * 40);
      cam.position.copy(position);
      next = cam;
    } else {
      const halfH = position.distanceTo(target) * Math.tan(THREE.MathUtils.degToRad((old as THREE.PerspectiveCamera).fov / 2));
      const cam = new THREE.OrthographicCamera(-halfH * aspect, halfH * aspect, halfH, -halfH, -20000, 40000);
      cam.position.copy(position);
      next = cam;
    }
    next.up.copy(old.up);
    next.lookAt(target);
    this.camera = next;
    this.controls.object = next;
    this.controls.update();
    this.setTool(this.tool);
    this.#dirty = true;
  }

  /** Screen ray to a plane, or null when the ray never meets it. */
  planePoint(clientX: number, clientY: number, origin: Vec3, normal: Vec3): Vec3 | null {
    const ray = this.#ray(clientX, clientY);
    const plane = new THREE.Plane(new THREE.Vector3(...normal).normalize(), 0);
    plane.constant = -plane.normal.dot(new THREE.Vector3(...origin));
    const p = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, p)) return null;
    return [p.x, p.y, p.z];
  }

  groundPoint(clientX: number, clientY: number): Vec3 | null {
    return this.planePoint(clientX, clientY, [0, 0, 0], [0, 0, 1]);
  }

  screenOf(p: Vec3): { x: number; y: number } {
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: ((v.x + 1) / 2) * r.width + r.left, y: ((1 - v.y) / 2) * r.height + r.top };
  }

  /**
   * Point the camera along a world direction and redraw. This is the only
   * thing that changes `up`, so after an outside orbit the next view command
   * still lands on the standard axes instead of a tilted one.
   */
  setView(direction: Vec3): void {
    const dir = new THREE.Vector3(...direction).normalize();
    const target = this.controls.target.clone();
    const distance = Math.max(this.camera.position.distanceTo(target), 1);
    const up = Math.abs(dir.z) > 0.999 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    this.camera.up.copy(up);
    this.camera.position.copy(target).addScaledVector(dir, distance);
    this.camera.lookAt(target);
    this.controls.update();
    this.#dirty = true;
  }

  /** The six standard views plus isometric, named the way the toolbar names them. */
  standardView(name: "iso" | "top" | "front" | "right" | "back" | "left" | "bottom"): void {
    const dirs: Record<typeof name, Vec3> = {
      iso: [1, -1, 0.8],
      top: [0, 0, 1],
      bottom: [0, 0, -1],
      front: [0, -1, 0],
      back: [0, 1, 0],
      right: [1, 0, 0],
      left: [-1, 0, 0],
    };
    this.setView(dirs[name]);
    this.zoomExtents();
  }

  /** Ask the gizmo to edit translation, rotation or scale only. */
  setGizmoMode(mode: "translate" | "rotate" | "scale"): void {
    this.gizmo.setMode(mode);
    this.#dirty = true;
  }

  /**
   * SketchUp's three drawing styles, which are the three ways people read a
   * model. Shaded is the default; hidden line and edges are line drawings, so
   * they drop colour and lighting rather than tinting the same shading.
   *
   * X-ray is not a fourth style. It is a lens laid over whichever style is
   * current: the faces go translucent so hidden edges show through, which is
   * how a user checks whether a wall actually meets a floor before trusting a
   * camera angle. So the style and the x-ray flag are stored separately.
   */
  setStyle(style: "shaded" | "hiddenLine" | "edges"): void {
    this.#style = style;
    for (const c of this.#cache.values()) this.#applyStyle(c);
    this.grid.visible = style === "shaded";
    this.#dirty = true;
  }

  /** Toggle the x-ray lens without disturbing the chosen drawing style. */
  setXray(on: boolean): void {
    this.#xray = on;
    for (const [id, c] of this.#cache) this.#applyStyle(c, this.#session.document.solids.get(id));
    this.#dirty = true;
  }

  get xray(): boolean {
    return this.#xray;
  }

  /** X-ray strength: low enough to see through, high enough to read a form. */
  static readonly XRAY_OPACITY = 0.28;

  get style(): "shaded" | "hiddenLine" | "edges" {
    return this.#style;
  }

  /** Sun shadows on or off. Off also frees the shadow-map pass. */
  setShadows(on: boolean): void {
    this.#shadows = on;
    this.solar.castShadow = on;
    this.ground.visible = on;
    this.renderer.shadowMap.enabled = on;
    this.renderer.shadowMap.needsUpdate = true;
    // Every material is compiled against "uses shadows" or not; the change only
    // takes effect after a recompile, which this forces once.
    for (const c of this.#cache.values()) {
      (c.mesh.material as THREE.Material).needsUpdate = true;
      c.mesh.receiveShadow = on && !c.mesh.userData["edgeOnly"];
    }
    this.#dirty = true;
  }

  get shadows(): boolean {
    return this.#shadows;
  }

  /** World axes: red/green/blue. Hidden in line styles, where they just add noise. */
  setAxesVisible(visible: boolean): void {
    this.#axesVisible = visible;
    this.axes.visible = visible;
    this.#dirty = true;
  }

  get axesVisible(): boolean {
    return this.#axesVisible;
  }

  /** The gizmo follows a single selected solid; the app owns the selection. */
  attachGizmo(id: SolidId | null): void {
    const c = id ? this.#cache.get(id) : undefined;
    if (!c) {
      this.gizmo.detach();
      return;
    }
    if (this.gizmo.object !== c.mesh) this.gizmo.attach(c.mesh);
  }

  /**
   * Whether right now is a good moment to start a drag on the selected object.
   *
   * A member of a group has no mesh of its own (the group draws it), and moving
   * it would take it out of the group, which is never what a plain drag means.
   * So the gizmo and the Move/Rotate/Scale tools refuse, and say why: the user
   * has to enter the group first. SketchUp behaves the same way for the same
   * reason. A root is always draggable.
   */
  canTransform(id: SolidId): { ok: true } | { ok: false; reason: string } {
    if (this.#cache.has(id)) return { ok: true };
    const doc = this.#session.document;
    const solid = doc.solids.get(id);
    if (!solid) return { ok: false, reason: "That object is no longer in the model." };
    const owners = ancestorsThroughGroups(doc, id);    if (owners.length === 0) return { ok: true };
    const name = doc.solids.get(owners[0]!)?.meta.name ?? "a group";
    return { ok: false, reason: `${solid.meta.name} is inside "${name}". Double-click to enter it, or ungroup first.` };
  }

  dispose(): void {
    window.removeEventListener("keydown", this.#onKeyDown);
    window.removeEventListener("keyup", this.#onKeyUp);
    // The pointerup listener is on window: leaving it behind would keep a
    // disposed view alive and end every drag in a stale closure.
    window.removeEventListener("pointerup", this.#onPointerUp);
    this.gizmo.getHelper().removeFromParent();
    this.controls.dispose();
    this.gizmo.dispose();
    this.#resizeObserver.disconnect();
    for (const c of this.#cache.values()) this.#disposeCache(c);
    this.renderer.dispose();
  }

  /* -------------------------------------------------------------- picking */

  #ray(clientX: number, clientY: number): THREE.Raycaster {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.#pointer.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.#raycaster.setFromCamera(this.#pointer, this.camera);
    return this.#raycaster;
  }

  pick(clientX: number, clientY: number): PickHit | null {
    if (this.gizmo.dragging) return { kind: "gizmo" };
    const ray = this.#ray(clientX, clientY);
    const meshes: THREE.Mesh[] = [];
    for (const c of this.#cache.values()) {
      if (this.#session.document.solids.get(c.mesh.userData["solidId"] as SolidId)?.meta.hidden) continue;
      meshes.push(c.mesh);
    }
    const hits = ray.intersectObjects(meshes, false);
    const first = hits[0];
    if (first && first.face) {
      const n = first.face.normal
        .clone()
        .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(first.object.matrixWorld))
        .normalize();
      return {
        kind: "solid",
        id: first.object.userData["solidId"] as SolidId,
        faceNormal: [n.x, n.y, n.z],
        point: [first.point.x, first.point.y, first.point.z],
      };
    }
    const g = this.groundPoint(clientX, clientY);
    return g ? { kind: "ground", point: g } : null;
  }

  /* ---------------------------------------------------------------- sync */

  /** Full reconcile: build, rebuild or dispose every mesh. Used on undo/redo/load. */
  sync(): void {
    const wanted = new Set(drawnSolids(this.#session.document));
    const stale = [...this.#cache.keys()].filter((id) => !wanted.has(id));
    this.syncPatches([...wanted], new Set(stale));
    this.#applySection();
  }

  /** Reconcile only `touched`; `removed` are ids the patch deleted. */
  syncPatches(touched: Iterable<SolidId>, removed: ReadonlySet<SolidId> = new Set()): void {
    // A child that moved is already inside its group's merged mesh, and the
    // group is what draws. Expand the touched set up through every group
    // ancestor, so editing a member never leaves the parent showing old
    // triangles. Transform and instance owners are left to their own revision,
    // because the session bumps it with its dependents.
    const touchedIds = new Set<SolidId>(touched);
    const doc0 = this.#session.document;
    for (const id of [...touchedIds]) {
      for (const owner of ancestorsThroughGroups(doc0, id)) touchedIds.add(owner);
    }
    const touchedSet = touchedIds;
    const doc = this.#session.document;
    for (const id of removed) {
      const cached = this.#cache.get(id);
      if (cached) this.#disposeCache(cached);
      this.#cache.delete(id);
    }
    for (const id of touchedSet) {
      if (removed.has(id)) continue;
      const solid = doc.solids.get(id);
      const cached = this.#cache.get(id);
      if (!solid) {
        if (cached) this.#disposeCache(cached);
        this.#cache.delete(id);
        continue;
      }
      if (cached && cached.revision === solid.revision) {
        // Metadata-only change (name, colour, visibility): refresh, do not rebuild.
        this.#applyMeta(cached, solid);
        continue;
      }
      if (cached) {
        this.#disposeCache(cached);
        this.#cache.delete(id);
      }
      this.#cache.set(id, this.#build(solid));
    }
    this.#dirty = true;
  }

  /** Red-outline the solids that break the fit envelope. */
  markFailures(ids: ReadonlySet<SolidId>, selected: ReadonlySet<SolidId>): void {
    for (const [id, c] of this.#cache) {
      const line = c.edges.material as THREE.LineBasicMaterial;
      if (ids.has(id)) {
        line.color.set(0xe8664b);
        line.opacity = 1;
      } else if (selected.has(id)) {
        line.color.set(0xffb347);
        line.opacity = 1;
      } else {
        line.color.set(0x2a2a2a);
        line.opacity = 0.55;
      }
      const mat = c.mesh.material as THREE.MeshStandardMaterial;
      if (selected.has(id)) mat.color.copy(c.baseColor).lerp(new THREE.Color("#ffd27a"), 0.4);
      else mat.color.copy(c.baseColor);
    }
    this.#dirty = true;
  }

  /* --------------------------------------------------------------- section */

  /**
   * Show the document's section cut. Three.js clips in world space, so one
   * plane per axis is created once and only the active one is attached; the
   * flipped side is achieved by negating the normal, not by moving the plane.
   */
  #applySection(): void {
    const section = this.#session.document.section;
    const planes: THREE.Plane[] = [];
    if (section) {
      const normal = new THREE.Vector3(0, 0, 0);
      const component = section.axis === "x" ? "x" : section.axis === "y" ? "y" : "z";
      normal[component] = section.flip ? 1 : -1;
      planes.push(new THREE.Plane(normal, section.flip ? -section.offset : section.offset));
    }
    this.renderer.clippingPlanes = planes;
    // The shadow map ignores clipping planes unless this is on, which would
    // leave a full-length shadow for half a model.
    this.renderer.localClippingEnabled = section !== null;
    this.#dirty = true;
  }

  #applyMeta(c: CachedMesh, solid: Solid): void {
    c.mesh.name = solid.meta.name;
    c.baseColor.set(solid.meta.color);
    const mat = c.mesh.material as THREE.MeshStandardMaterial;
    mat.color.copy(c.baseColor);
    // Finish: roughness and metal come straight from the solid, so a brushed
    // steel panel reads as metal in the shaded style without a texture.
    mat.roughness = solid.meta.roughness;
    mat.metalness = solid.meta.metallic;
    // Translucent geometry must not write depth, or it hides the edges of
    // whatever sits behind it and looks like a hole rather than glass. X-ray
    // forces this on for every solid, so the whole model reads as one plane of
    // glass; the applied values live in `#applyStyle` so toggling x-ray does
    // not have to rebuild the mesh.
    this.#applyStyle(c, solid);
  }

  /**
   * Per-solid look for the current style. Hidden line and edges drop the
   * colour fill; the mesh stays in the scene (invisible) so picking and the
   * gizmo keep working while only the outline is drawn.
   */
  #applyStyle(c: CachedMesh, solid?: Solid): void {
    const mat = c.mesh.material as THREE.MeshStandardMaterial;
    const hidden = solid ? solid.meta.hidden : false;
    // The solid's own opacity, unless x-ray is on: then everything is equally
    // see-through, including solids the user has already made translucent,
    // because the point of x-ray is to read the whole model at once.
    const own = solid ? solid.meta.opacity : 1;
    const opacity = this.#xray ? Math.min(own, View.XRAY_OPACITY) : own;
    const opaque = opacity >= 1;
    mat.transparent = !opaque;
    mat.opacity = opacity;
    mat.depthWrite = opaque;
    if (this.#style === "shaded") {
      mat.color.copy(c.baseColor);
      mat.visible = true;
      c.edges.visible = !hidden;
      c.mesh.visible = !hidden;
      // A see-through solid casting a solid shadow reads as a bug.
      c.mesh.castShadow = this.#shadows && opaque;
      c.mesh.receiveShadow = this.#shadows;
      c.mesh.userData["edgeOnly"] = false;
      (c.edges.material as THREE.LineBasicMaterial).color.set(0x2a2a2a);
      (c.edges.material as THREE.LineBasicMaterial).opacity = this.#xray ? 0.9 : 0.55;
      this.#dirty = true;
      return;
    }
    // Both line styles draw white faces (or none) with black edges, and shadows
    // would betray a face that is meant to read as paper.
    mat.color.set(0xffffff);
    // X-ray over a line drawing shows the faces faintly instead of not at all;
    // otherwise hidden line would ignore the lens entirely.
    mat.visible = this.#style === "hiddenLine" || this.#xray;
    c.edges.visible = !hidden;
    c.mesh.visible = !hidden;
    c.mesh.castShadow = false;
    c.mesh.receiveShadow = false;
    c.mesh.userData["edgeOnly"] = true;
    (c.edges.material as THREE.LineBasicMaterial).color.set(0x111111);
    (c.edges.material as THREE.LineBasicMaterial).opacity = 1;
    this.#dirty = true;
  }

  #build(solid: Solid): CachedMesh {
    const geometry = toBufferGeometry(this.#session.meshOf(solid.id));
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(solid.meta.color),
      roughness: solid.meta.roughness,
      metalness: solid.meta.metallic,
      flatShading: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.visible = !solid.meta.hidden;
    mesh.userData["solidId"] = solid.id;
    mesh.name = solid.meta.name;

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry, 15),
      new THREE.LineBasicMaterial({ color: 0x2a2a2a, transparent: true, opacity: 0.55 }),
    );
    edges.visible = !solid.meta.hidden;
    edges.raycast = () => {};
    mesh.add(edges);

    this.content.add(mesh);
    return { revision: solid.revision, mesh, edges, baseColor: new THREE.Color(solid.meta.color) };
  }

  #disposeCache(c: CachedMesh): void {
    if (this.gizmo.object === c.mesh) this.gizmo.detach();
    this.content.remove(c.mesh);
    c.mesh.geometry.dispose();
    (c.mesh.material as THREE.Material).dispose();
    c.edges.geometry.dispose();
    (c.edges.material as THREE.Material).dispose();
  }

  /* --------------------------------------------------------------- gizmo */

  #onGizmoDragging(dragging: boolean): void {
    const id = this.gizmo.object?.userData["solidId"] as SolidId | undefined;
    if (dragging) {
      if (!id) return;
      this.#gizmoStart = { id, matrix: [...this.#session.document.solids.get(id)!.recipe.matrix] };
    } else if (this.#gizmoStart && this.gizmo.object) {
      this.#gizmoStart = null;
      const matrix = this.gizmo.object.matrix.clone();
      this.#events.onGizmoCommit(id!, Array.from(matrix.elements));
    }
    this.#dirty = true;
  }

  /* ------------------------------------------------------------ scaffold */

  #buildEnvironment(): { grid: THREE.GridHelper; axes: THREE.AxesHelper; sun: THREE.DirectionalLight; ground: THREE.Mesh } {
    const hemi = new THREE.HemisphereLight("#dfe8f2", "#2b2a28", 1.6);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight("#fff5e6", 2.2);
    sun.position.set(800, -900, 1600);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 1800;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 6000 });
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);

    const grid = new THREE.GridHelper(4000, 80, 0x4a5058, 0x33383e);
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);

    const axes = new THREE.AxesHelper(260);
    this.scene.add(axes);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000),
      new THREE.ShadowMaterial({ opacity: 0.22 }),
    );
    ground.receiveShadow = true;
    ground.raycast = () => {};
    this.scene.add(ground);
    return { grid, axes, sun, ground };
  }

  #resize(container: HTMLElement): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    const aspect = w / h;
    const cam = this.camera;
    if (cam instanceof THREE.PerspectiveCamera) {
      cam.aspect = aspect;
    } else {
      const half = Math.abs(cam.top);
      cam.left = -half * aspect;
      cam.right = half * aspect;
    }
    cam.updateProjectionMatrix();
    this.#dirty = true;
  }

  /* -------------------------------------------------------------- input */

  /** Double-click enters a group: the next pick inside it selects the member. */
  #onDoubleClick = (e: MouseEvent): void => {
    const hit = this.pick(e.clientX, e.clientY);
    if (hit?.kind === "solid") this.#events.onEnter(hit.id);
  };

  #onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Shift") this.#shift = true;
    // Only the modifier is tracked here: every command, Z included, is routed
    // through the app's generated shortcut table so there is one key map.
  };

  #onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === "Shift") this.#shift = false;
  };

  #onPointerDown = (e: PointerEvent): void => {
    const local = this.#local(e);
    this.#downAt = local;
    // The right button starts a lasso when Select is active; the context menu
    // is already suppressed on the canvas, so nothing is taken from the user.
    this.#lasso = isLassoDrag(e.button, this.tool) ? [local] : null;
    if (this.#lasso) {
      this.controls.enabled = false;
      this.#showLasso(this.#lasso);
    }
  };

  #onPointerUp = (e: PointerEvent): void => {
    const down = this.#downAt;
    this.#downAt = null;
    this.#hideMarquee();
    const path = this.#lasso;
    this.#lasso = null;
    this.controls.enabled = true;
    if (path) {
      // A lasso is the same gesture as a rectangle: the path decides the rule.
      this.#finishLasso(path, e.shiftKey);
      return;
    }
    if (!down || e.button !== 0) return;
    const to = this.#local(e);
    // A drag is either a marquee or a camera orbit, never a pick.
    if (Math.hypot(to.x - down.x, to.y - down.y) > 4) {
      if (this.tool === "select") this.#finishMarquee(down, to, e.shiftKey);
      return;
    }
    const hit = this.pick(e.clientX, e.clientY);
    if (hit) this.#events.onPick(hit, e.shiftKey, e.ctrlKey || e.metaKey);
  };

  /** Screen position relative to the canvas, for the live drag rectangle. */
  #local(e: PointerEvent): { x: number; y: number } {
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /**
   * Where a solid sits on screen, as a pixel box around its eight corners.
   * `null` when any corner is behind the camera: a solid the user cannot see
   * must never be caught by a rectangle.
   */
  screenBox(id: SolidId): ScreenBox | null {
    const b = this.#session.boundsOf(id);
    const r = this.renderer.domElement.getBoundingClientRect();
    // In orthographic there is no "behind the camera" for a corner in front of
    // the near plane, but a box straddling it must still be rejected.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 8; i++) {
      const corner = new THREE.Vector3(
        i & 1 ? b.max[0] : b.min[0],
        i & 2 ? b.max[1] : b.min[1],
        i & 4 ? b.max[2] : b.min[2],
      );
      // Orthographic projection turns everything in front of the near plane
      // around, so a corner behind the camera would project to a mirrored
      // place. There is no image of such a corner to drag over.
      const depth = corner.clone().applyMatrix4(this.camera.matrixWorldInverse).z;
      if (depth > -this.camera.near) return null;
      corner.project(this.camera);
      const x = ((corner.x + 1) / 2) * r.width;
      const y = ((1 - corner.y) / 2) * r.height;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    return { minX, minY, maxX, maxY };
  }

  #finishMarquee(from: { x: number; y: number }, to: { x: number; y: number }, shift: boolean): void {
    const box = dragBox(from.x, from.y, to.x, to.y);
    if (isDegenerate(box)) return;
    const direction = dragDirection(from.x, to.x);
    const ids = selectByDrag(
      this.selectableIds(),
      box,
      direction,
      (id) => this.screenBox(id as SolidId),
    );
    this.#events.onMarquee(ids as SolidId[], shift);
  }

  /** Finish a lasso: the path's own direction decides window vs crossing. */
  #finishLasso(path: readonly { x: number; y: number }[], shift: boolean): void {
    if (!isLassoPath(path)) return;
    const points = path.map((p) => [p.x, p.y] as const);
    const ids = selectByLasso(
      this.selectableIds(),
      points,
      (id) => this.screenBox(id as SolidId),
    );
    this.#events.onMarquee(ids as SolidId[], shift);
  }

  /** Ids a selection gesture may pick: everything drawn, minus locked objects. */
  selectableIds(): string[] {
    return drawnSolids(this.#session.document)
      .filter((s) => !s.meta.hidden && !s.meta.locked)
      .map((s) => s.id);
  }

  /** Draw the live lasso as an SVG-free polyline, tinted by its rule. */
  #showLasso(path: readonly { x: number; y: number }[]): void {
    const el = this.#marqueeEl;
    if (!el) return;
    const points = path.map((p) => [p.x, p.y]);
    const last = points[points.length - 1];
    if (points.length > 1 && last) points.push([points[0]![0]!, points[0]![1]!]);
    const crossing = lassoDirection(path.map((p) => [p.x, p.y] as const)) === "crossing";
    el.hidden = false;
    el.className = crossing ? "lasso crossing" : "lasso window";
    el.style.left = "0px";
    el.style.top = "0px";
    el.style.width = "100%";
    el.style.height = "100%";
    el.style.background = "none";
    el.style.border = "none";
    // A polygon in one inline style: one element, no images, no layout thrash
    // beyond the clip-path itself.
    el.style.clipPath = `polygon(${points.map(([x, y]) => `${x}px ${y}px`).join(", ")})`;
  }

  /** Draw the live drag rectangle, tinted to say which rule it will apply. */
  #showMarquee(ax: number, ay: number, bx: number, by: number): void {
    const el = this.#marqueeEl;
    if (!el) return;
    const box = dragBox(ax, ay, bx, by);
    const crossing = dragDirection(ax, bx) === "crossing";
    el.hidden = false;
    el.className = crossing ? "crossing" : "window";
    // A rectangle and a lasso share this element, so every rectangle-only style
    // must be restored here: a leftover clip-path would show the previous lasso.
    el.style.clipPath = "none";
    el.style.background = "";
    el.style.border = "";
    el.style.left = `${box.minX}px`;
    el.style.top = `${box.minY}px`;
    el.style.width = `${box.maxX - box.minX}px`;
    el.style.height = `${box.maxY - box.minY}px`;
  }

  #hideMarquee(): void {
    if (this.#marqueeEl) this.#marqueeEl.hidden = true;
  }

  #onPointerMove = (e: PointerEvent): void => {
    if (e.buttons !== 0) {
      const down = this.#downAt;
      const path = this.#lasso;
      if (path && this.tool === "select") {
        const local = this.#local(e);
        const last = path[path.length - 1]!;
        // Sampling every few pixels keeps the path short enough to test and
        // smooth enough to read as the user's own line.
        if (Math.hypot(local.x - last.x, local.y - last.y) >= LASSO_STEP) {
          path.push(local);
          this.#showLasso(path);
        }
        return;
      }
      // Only a select-tool drag is a marquee; anything else is orbiting.
      if (down && this.tool === "select" && !this.gizmo.dragging && e.buttons === 1) {
        this.#showMarquee(down.x, down.y, e.clientX, e.clientY);
      }
      return;
    }
    const hit = this.pick(e.clientX, e.clientY);
    const point = hit && hit.kind === "ground" ? hit.point : hit && hit.kind === "solid" ? hit.point : null;
    this.#events.onHover(point);
  };

  /* --------------------------------------------------------------- loop */

  #loop = (): void => {
    requestAnimationFrame(this.#loop);
    this.controls.update();
    if (this.gizmo.dragging) this.#dirty = true;
    if (!this.#dirty) return;
    this.#dirty = false;
    this.#cull();
    this.renderer.render(this.scene, this.camera);
  };

  /** Frustum-cull meshes, but never the one being edited (an edit must show even off-centre). */
  #cull(): void {
    this.#projScreen.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.#frustum.setFromProjectionMatrix(this.#projScreen);
    const editing = this.gizmo.object;
    for (const c of this.#cache.values()) {
      const solid = this.#session.document.solids.get(c.mesh.userData["solidId"] as SolidId);
      c.mesh.visible = !solid?.meta.hidden && (c.mesh === editing || this.#frustum.intersectsObject(c.mesh));
      c.edges.visible = c.mesh.visible;
    }
  }
}

function toBufferGeometry(mesh: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  g.computeVertexNormals();
  return g;
}

export type { Aabb };
