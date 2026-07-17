/**
 * Force simulation: in-place nodes + alpha decay (Cognit-mf8 G3/G4).
 */
import { describe, expect, it } from "vitest";
import {
  forceCenter,
  forceManyBody,
  forceSimulation,
  type SimNode,
} from "@/lib/force-simulation";

describe("forceSimulation", () => {
  it("mutates input nodes in place (no copy)", () => {
    const nodes: SimNode[] = [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 10, y: 0 },
    ];
    const sim = forceSimulation(nodes);
    sim.force("charge", forceManyBody({ strength: -80 }));
    sim.force("center", forceCenter(0, 0));
    sim.alpha(1);
    sim.tick(5);
    const out = sim.nodes();
    expect(out[0]).toBe(nodes[0]);
    expect(out[1]).toBe(nodes[1]);
    // Positions should have moved from the seed under charge.
    const moved =
      Math.abs((nodes[0]!.x ?? 0) - 0) > 0.01 ||
      Math.abs((nodes[1]!.x ?? 10) - 10) > 0.01;
    expect(moved).toBe(true);
  });

  it("alpha decays toward zero and settles", () => {
    const nodes: SimNode[] = [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 50, y: 0 },
    ];
    const sim = forceSimulation(nodes);
    sim.force("charge", forceManyBody({ strength: -40 }));
    sim.alpha(1);
    let steps = 0;
    while (sim.alpha() > 0 && steps < 2000) {
      sim.tick(1);
      steps += 1;
    }
    expect(sim.alpha()).toBe(0);
    expect(steps).toBeLessThan(2000);
    expect(steps).toBeGreaterThan(10);
  });
});
