/**
 * Golden replay gate (D-M1-00).
 *
 * Loads each fixture under fixtures/golden/, folds events through the
 * pure reducer, and deep-compares entity-level state to expected-state.json.
 * Timeline is stripped (see fixtures/golden/README.md).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reduce } from "../src/reducer.js";
import { emptySessionState, type ReducerEvent } from "../src/state.js";
import { entityStateForCompare } from "../src/serialize-state.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const goldenRoot = path.resolve(here, "../fixtures/golden");

const listFixtureDirs = (): string[] => {
  if (!fs.existsSync(goldenRoot)) return [];
  return fs
    .readdirSync(goldenRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
};

const loadEvents = (dir: string): ReducerEvent[] => {
  const raw = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ReducerEvent);
};

const loadExpected = (dir: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(dir, "expected-state.json"), "utf8"));

const loadMeta = (dir: string): { fixture_format: number; intent: string } =>
  JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as {
    fixture_format: number;
    intent: string;
  };

describe("golden replay", () => {
  const fixtures = listFixtureDirs();

  it("discovers at least one golden fixture", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const name of fixtures) {
    it(`fixture ${name}: reduce(events) matches expected-state.json`, () => {
      const dir = path.join(goldenRoot, name);
      const meta = loadMeta(dir);
      expect(meta.fixture_format).toBe(1);
      expect(meta.intent.length).toBeGreaterThan(0);

      const events = loadEvents(dir);
      expect(events.length).toBeGreaterThan(0);

      const first = events[0]!;
      const initial = emptySessionState({
        session_id: first.session_id,
        project_id: first.project_id,
        goal: "",
      });
      const actual = entityStateForCompare(reduce(events, initial));
      const expected = loadExpected(dir);
      expect(actual).toEqual(expected);
    });
  }

  it("gate is live: mutating an event type makes the comparison fail", () => {
    const name = fixtures[0];
    expect(name).toBeDefined();
    const dir = path.join(goldenRoot, name!);
    const events = loadEvents(dir).map((e, i) =>
      i === 1 ? { ...e, type: "observation_recorded_MUTATED" } : e,
    );
    const first = events[0]!;
    const initial = emptySessionState({
      session_id: first.session_id,
      project_id: first.project_id,
      goal: "",
    });
    const actual = entityStateForCompare(reduce(events, initial));
    const expected = loadExpected(dir);
    expect(actual).not.toEqual(expected);
  });
});
