import type * as THREE from "three";
import type { Session } from "@apexus/engine";

/**
 * The context bus: the ports every actor reaches the rest through.
 *
 * The app has three kinds of actor and they must not import each other:
 *
 *   - **domain modules** (`selection`, `materials`, `annotations.view`) hold a
 *     slice of app state and know nothing beyond it;
 *   - **presenters** (`view`, `tools`, `palette`) read a slice and draw, or
 *     mutate through a `Command`;
 *   - **the composition root** (`main.ts`) owns the instances and passes the
 *     shared ports down.
 *
 * A module takes the pieces it needs as parameters and returns its own narrow
 * interface. The alternative — a module-level `let` read by every importer —
 * makes the dependency graph invisible: every file can reach everything, so the
 * layering in ADR 0005 survives only as a comment. The cost of that
 * invisibility shows up the first time two modules need the same value and it is
 * claimed by whoever imported first.
 *
 * `Shell` is deliberately *ports only*: no behaviour lives here, so it can never
 * become the god object `main.ts` used to be. Anything with a rule in it belongs
 * in a module that owns that rule.
 */

/** Every user-visible message goes through here, so the hint line has one writer. */
export interface HintSink {
  /** Say something. The last thing said stays until something else is said. */
  say(text: string): void;
  /** The element, for the smoke test to read. Not for logic. */
  readonly element: HTMLElement;
}

/**
 * How the user's last pick turned out, in words plus the raw click.
 *
 * This is the one signal that must travel from the viewport to the tool *and* to
 * the selection, in that order: the tool may replace the selection with a new
 * object (draw a face, then select it), so selection must not be recomputed from
 * the hit afterwards.
 */
export interface HitOutcome {
  /** The hit with any group context folded in: the object the user meant. */
  readonly hit: import("./view.js").PickHit;
  /** Shift held: add to (or toggle in) the selection. */
  readonly additive: boolean;
  /** Ctrl held: the tool should copy rather than move. */
  readonly copy: boolean;
}

export interface Shell {
  readonly session: Session;
  /** Where the model is drawn. Created by the root because it needs the container. */
  readonly view: import("./view.js").View;
  readonly hint: HintSink;
  /** Where styles, labels and overlay geometry are added by the app layer. */
  readonly scene: THREE.Scene;
}

/**
 * The five ways a two-object boolean can only be enabled when the kernel is up.
 * Named rather than inlined so a presenter can ask "is this possible" once.
 */
export interface KernelPort {
  ready(): boolean;
}
