import { describe, expect, it } from "vitest";
import { ACTOR_TYPES, type ActorType } from "../src/actor-types.js";

describe("actor-types", () => {
  it("ACTOR_TYPES has exactly ['human', 'worker', 'system']", () => {
    expect(ACTOR_TYPES).toEqual(["human", "worker", "system"]);
    expect(ACTOR_TYPES.length).toBe(3);
  });

  it("ActorType union is the element type of ACTOR_TYPES", () => {
    const sample: ActorType = "human";
    expect(sample).toBe("human");
  });

  it("Set membership round-trip: every tuple member is in a Set built from ACTOR_TYPES", () => {
    const set = new Set<ActorType>(ACTOR_TYPES);
    for (const a of ACTOR_TYPES) {
      expect(set.has(a)).toBe(true);
    }
    expect(set.size).toBe(ACTOR_TYPES.length);
  });

  it("Set membership rejects unknown values", () => {
    const set = new Set<ActorType>(ACTOR_TYPES);
    expect(set.has("bot" as ActorType)).toBe(false);
  });
});
