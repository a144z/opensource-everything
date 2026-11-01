import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import type { Aabb, MeshData, Vec3 } from "@apexus/geometry";
import {
  dragBox,
  dragDirection,
  isDegenerate,
  selectByDrag,
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
  | "arc";

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
  readonly camera: THREE.OrthographicCamera;
  readonly controls: OrbitControls;
  readonly gizmo: TransformControls;
  readonly content = new THREE.Group();
  readonly grid: THREE.GridHelper;
  readonly axes: THREE.AxesHelper;

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
  #gizmoStart: { id: SolidId; matrix: number[] } | null = null;
  #shift = false;
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
    const { grid, axes } = this.#buildEnvironment();
    this.grid = grid;
    this.axes = axes;
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
    const worldHeight = (this.camera.top - this.camera.bottom) / this.camera.zoom;
    return worldHeight / Math.max(r.height, 1);
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
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.left = -halfH * aspect;
    this.camera.right = halfH * aspect;
    this.camera.updateProjectionMatrix();
    this.controls.update();
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

  /** Ask the gizmo to edit translation, rotation or scale only. */
  setGizmoMode(mode: "translate" | "rotate" | "scale"): void {
    this.gizmo.setMode(mode);
    this.#dirty = true;
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

  dispose(): void {
    window.removeEventListener("keydown", this.#onKeyDown);
    window.removeEventListener("keyup", this.#onKeyUp);
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
    this.syncPatches([...this.#session.document.solids.keys()], new Set());
    this.#applySection();
  }

  /** Reconcile only `touched`; `removed` are ids the patch deleted. */
  syncPatches(touched: Iterable<SolidId>, removed: ReadonlySet<SolidId> = new Set()): void {
    const doc = this.#session.document;
    for (const id of removed) {
      const cached = this.#cache.get(id);
      if (cached) this.#disposeCache(cached);
      this.#cache.delete(id);
    }
    for (const id of touched) {
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

  #applyMeta(c: CachedMesh, solid: Solid): void {    c.mesh.name = solid.meta.name;
    c.baseColor.set(solid.meta.color);
    const mat = c.mesh.material as THREE.MeshStandardMaterial;
    mat.color.copy(c.baseColor);
    // Translucent geometry must not write depth, or it hides the edges of
    // whatever sits behind it and looks like a hole rather than glass.
    const opaque = solid.meta.opacity >= 1;
    mat.transparent = !opaque;
    mat.opacity = solid.meta.opacity;
    mat.depthWrite = opaque;
    c.mesh.castShadow = opaque;
    c.mesh.visible = !solid.meta.hidden;
    c.edges.visible = !solid.meta.hidden;
  }

  #build(solid: Solid): CachedMesh {
    const geometry = toBufferGeometry(this.#session.meshOf(solid.id));
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(solid.meta.color),
      roughness: 0.72,
      metalness: 0.02,
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

  #buildEnvironment(): { grid: THREE.GridHelper; axes: THREE.AxesHelper } {
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
    return { grid, axes };
  }

  #resize(container: HTMLElement): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    const aspect = w / h;
    const half = Math.abs(this.camera.top);
    this.camera.left = -half * aspect;
    this.camera.right = half * aspect;
    this.camera.updateProjectionMatrix();
    this.#dirty = true;
  }

  /* -------------------------------------------------------------- input */

  #onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Shift") this.#shift = true;
    if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
    if (e.key.toLowerCase() === "z" && !e.ctrlKey && !e.metaKey) this.zoomExtents();
  };

  #onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === "Shift") this.#shift = false;
  };

  #onPointerDown = (e: PointerEvent): void => {
    this.#downAt = this.#local(e);
  };

  #onPointerUp = (e: PointerEvent): void => {
    const down = this.#downAt;
    this.#downAt = null;
    this.#hideMarquee();
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
      // Behind the camera (or on the near plane) is not a visible point.
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
      [...this.#session.document.solids.keys()].filter(
        (id) => !this.#session.document.solids.get(id)!.meta.hidden,
      ),
      box,
      direction,
      (id) => this.screenBox(id as SolidId),
    );
    this.#events.onMarquee(ids as SolidId[], shift);
  }

  /** Draw the live drag rectangle, tinted to say which rule it will apply. */
  #showMarquee(ax: number, ay: number, bx: number, by: number): void {
    const el = this.#marqueeEl;
    if (!el) return;
    const box = dragBox(ax, ay, bx, by);
    const crossing = dragDirection(ax, bx) === "crossing";
    el.hidden = false;
    el.className = crossing ? "crossing" : "window";
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
