/**
 * apps/dashboard/src/lib/force-simulation.ts — minimal d3-force-style API.
 *
 * Implements just enough of the d3-force surface to drive the
 * Knowledge Graph "physics" layout. We deliberately avoid
 * pulling in d3-force as a dependency; the orchestrator rules
 * forbid new deps without explicit approval, and a 3-force
 * (charge + link + center) is sufficient for visualisation.
 *
 * Public API (mimics d3-force):
 *   forceSimulation(nodes)
 *     .force(name, forceFn)
 *     .alpha(a?) / .alphaMin() / .alphaDecay(d) / .velocityDecay(d)
 *     .restart() / .stop() / .tick()
 *
 *   forceManyBody()      — Coulomb repulsion
 *   forceLink(links?)    — Hooke spring on a list of {source,target}
 *   forceCenter(x, y)    — linear pull to (x, y)
 *
 * Nodes are mutated in place — positions are written back to
 * `node.x` / `node.y`. This mirrors d3-force and is what
 * GraphCanvas reads each tick.
 */

export type SimNode = {
  readonly id: string;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  index?: number;
};

export type SimLink = {
  readonly source: string | SimNode;
  readonly target: string | SimNode;
  distance?: number;
};

export type Force = (alpha: number) => void;
export type Simulation<NodeT extends SimNode> = {
  nodes: () => NodeT[];
  force: (name: string, fn: Force | null) => Simulation<NodeT>;
  /**
   * d3-force style: `alpha()` reads, `alpha(v)` writes and
   * returns the simulation. We mirror that exact behaviour so
   * `.alpha(1).restart()` chains naturally.
   */
  alpha: ((a?: number) => number) & ((a: number) => Simulation<NodeT>);
  alphaMin: ((a?: number) => number) & ((a: number) => Simulation<NodeT>);
  alphaDecay: ((d?: number) => number) & ((d: number) => Simulation<NodeT>);
  velocityDecay: ((d?: number) => number) & ((d: number) => Simulation<NodeT>);
  restart: () => Simulation<NodeT>;
  stop: () => Simulation<NodeT>;
  tick: (iterations?: number) => Simulation<NodeT>;
  on: (event: "tick" | "end", cb: (() => void) | null) => Simulation<NodeT>;
};

export const forceSimulation = <NodeT extends SimNode>(initialNodes: NodeT[]): Simulation<NodeT> => {
  const nodes: NodeT[] = initialNodes.map((n, i) => {
    const copy = { ...n } as NodeT;
    copy.x = n.x ?? Math.random() * 400;
    copy.y = n.y ?? Math.random() * 400;
    copy.vx = n.vx ?? 0;
    copy.vy = n.vy ?? 0;
    copy.fx = n.fx ?? null;
    copy.fy = n.fy ?? null;
    copy.index = i;
    return copy;
  });

  const forces = new Map<string, Force>();
  let alpha = 1;
  let alphaMin = 0.001;
  let alphaDecay = 1 - Math.pow(alphaMin, 1 / 300);
  let velocityDecay = 0.4;
  const tickListeners: Array<() => void> = [];
  const endListeners: Array<() => void> = [];

  // Helper: getter/setter that reads on no-arg and writes+returns-sim on arg.
  const makeChain = (ref: { value: number }) => {
    const fn = ((a?: number): number | Simulation<NodeT> => {
      if (typeof a === "number") {
        ref.value = a;
        return sim;
      }
      return ref.value;
    }) as unknown as Simulation<NodeT>["alpha"];
    return fn;
  };

  const alphaRef = { value: alpha };
  const alphaMinRef = { value: alphaMin };
  const alphaDecayRef = { value: alphaDecay };
  const velocityDecayRef = { value: velocityDecay };

  const sim: Simulation<NodeT> = {
    nodes: () => nodes,
    force: (name, fn) => {
      if (fn === null) {
        forces.delete(name);
      } else {
        const setter = (fn as unknown as { _setNodes?: (n: NodeT[]) => void })._setNodes;
        if (typeof setter === "function") setter(nodes);
        forces.set(name, fn);
      }
      return sim;
    },
    alpha: makeChain(alphaRef),
    alphaMin: makeChain(alphaMinRef),
    alphaDecay: makeChain(alphaDecayRef),
    velocityDecay: makeChain(velocityDecayRef),
    restart: () => {
      alphaRef.value = alphaRef.value < 0.1 ? 0.1 : alphaRef.value;
      return sim;
    },
    stop: () => {
      alphaRef.value = 0;
      return sim;
    },
    tick: (iterations = 1) => {
      for (let step = 0; step < iterations; step++) {
        for (const f of forces.values()) f(alphaRef.value);
        for (const n of nodes) {
          if (n.fx !== null && n.fx !== undefined) n.x = n.fx;
          if (n.fy !== null && n.fy !== undefined) n.y = n.fy;
          n.vx = (n.vx ?? 0) * (1 - velocityDecayRef.value);
          n.vy = (n.vy ?? 0) * (1 - velocityDecayRef.value);
          n.x = (n.x ?? 0) + (n.vx ?? 0);
          n.y = (n.y ?? 0) + (n.vy ?? 0);
        }
        alphaRef.value += alphaDecayRef.value;
        if (alphaRef.value < alphaMinRef.value) alphaRef.value = 0;
      }
      for (const cb of tickListeners) cb();
      if (alphaRef.value === 0) for (const cb of endListeners) cb();
      return sim;
    },
    on: (event, cb) => {
      const list = event === "tick" ? tickListeners : endListeners;
      if (cb === null) {
        // Listener removal by null is rare in our usage; clear
        // all listeners when cb is null. The d3-force idiom is
        // `sim.on("tick", null)` to remove a specific handler,
        // but we don't expose stable refs and tests only
        // register — never remove — so clearing is fine.
        list.length = 0;
      } else {
        list.push(cb);
      }
      return sim;
    },
  };
  return sim;
};

/**
 * Coulomb-like repulsion. Each node pushes every other node away
 * with strength `k / distance²`. Default strength tuned for a
 * 1000x600 viewport. Pairwise O(n²) is fine for ≤500 nodes.
 */
export const forceManyBody = <NodeT extends SimNode>(opts: { strength?: number } = {}): Force => {
  const strength = opts.strength ?? -120;
  let active: NodeT[] = [];
  const force: Force = (alpha: number) => {
    for (let i = 0; i < active.length; i++) {
      const a = active[i]!;
      for (let j = i + 1; j < active.length; j++) {
        const b = active[j]!;
        let dx = (b.x ?? 0) - (a.x ?? 0);
        let dy = (b.y ?? 0) - (a.y ?? 0);
        let dist2 = dx * dx + dy * dy;
        if (dist2 < 0.01) {
          dx = (Math.random() - 0.5) * 0.1;
          dy = (Math.random() - 0.5) * 0.1;
          dist2 = dx * dx + dy * dy + 0.01;
        }
        const dist = Math.sqrt(dist2);
        const f = (strength * alpha) / dist;
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;
        a.vx = (a.vx ?? 0) - fx;
        a.vy = (a.vy ?? 0) - fy;
        b.vx = (b.vx ?? 0) + fx;
        b.vy = (b.vy ?? 0) + fy;
      }
    }
  };
  (force as unknown as { _setNodes: (n: NodeT[]) => void })._setNodes = (n) => {
    active = n;
  };
  return force;
};

/**
 * Hooke-spring link force. Pulls linked nodes toward their
 * `distance` (default 60) with stiffness scaled by `alpha`.
 */
export const forceLink = <NodeT extends SimNode>(
  links: SimLink[],
  opts: { distance?: number; strength?: number } = {},
): Force => {
  const distance = opts.distance ?? 60;
  const strength = opts.strength ?? 0.3;
  let active: NodeT[] = [];
  const byId = new Map<string, NodeT>();
  const rebuild = (n: NodeT[]): void => {
    active = n;
    byId.clear();
    for (const node of n) byId.set(node.id, node);
  };
  const force: Force = (alpha: number) => {
    for (const link of links) {
      const sid = typeof link.source === "string" ? link.source : link.source.id;
      const tid = typeof link.target === "string" ? link.target : link.target.id;
      const a = byId.get(sid);
      const b = byId.get(tid);
      if (!a || !b) continue;
      const dx = (b.x ?? 0) - (a.x ?? 0);
      const dy = (b.y ?? 0) - (a.y ?? 0);
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const delta = dist - distance;
      const f = (strength * alpha * delta) / dist;
      const fx = dx * f;
      const fy = dy * f;
      a.vx = (a.vx ?? 0) + fx;
      a.vy = (a.vy ?? 0) + fy;
      b.vx = (b.vx ?? 0) - fx;
      b.vy = (b.vy ?? 0) - fy;
    }
  };
  (force as unknown as { _setNodes: (n: NodeT[]) => void })._setNodes = rebuild;
  void active;
  return force;
};

/**
 * Linear pull toward (cx, cy). With a low strength this acts
 * like d3-force's `forceCenter` (which is implemented as a
 * position-only weak force).
 */
export const forceCenter = <NodeT extends SimNode>(
  cx: number,
  cy: number,
  opts: { strength?: number } = {},
): Force => {
  const strength = opts.strength ?? 0.05;
  let active: NodeT[] = [];
  const force: Force = (_alpha: number) => {
    for (const n of active) {
      n.vx = (n.vx ?? 0) + ((cx - (n.x ?? 0)) * strength);
      n.vy = (n.vy ?? 0) + ((cy - (n.y ?? 0)) * strength);
    }
  };
  (force as unknown as { _setNodes: (n: NodeT[]) => void })._setNodes = (n) => {
    active = n;
  };
  return force;
};
