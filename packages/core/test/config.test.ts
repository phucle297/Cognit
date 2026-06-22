import { describe, expect, it } from "vitest";
import { defaultConfig, parseCognitConfig, CognitConfigSchema } from "../src/config.js";
import { Schema } from "effect";

describe("cognit.yaml schema", () => {
  it("accepts the default config emitted by `cognit init`", () => {
    const cfg = defaultConfig("cognit");
    expect(cfg.project.name).toBe("cognit");
    expect(cfg.redaction.enabled).toBe(true);
    expect(cfg.session.snapshot_every_n_events).toBe(100);
    expect(cfg.actors.defaults.worker).toBe(0.6);
  });

  it("round-trips the schema through encode/decode", () => {
    const cfg = defaultConfig("roundtrip");
    const encoded = Schema.encodeSync(CognitConfigSchema)(cfg);
    const decoded = parseCognitConfig(encoded);
    expect(decoded.project.name).toBe("roundtrip");
    expect(decoded.inbox.atomic_write_required).toBe(true);
  });

  it("rejects invalid trust scores", () => {
    const bad = {
      project: { name: "x" },
      actors: { defaults: { human: 1.5, worker: -0.1, system: 1.0 }, known: [] },
    };
    expect(() => parseCognitConfig(bad)).toThrow();
  });

  it("rejects unknown redaction action types", () => {
    const bad = {
      project: { name: "x" },
      cleanup: { unreferenced_action: "obliterate" },
    };
    expect(() => parseCognitConfig(bad)).toThrow();
  });

  it("applies defaults for omitted optional sections", () => {
    const minimal = { project: { name: "x" } };
    const parsed = parseCognitConfig(minimal);
    expect(parsed.redaction.enabled).toBe(true);
    expect(parsed.inbox.watch).toBe(true);
    expect(parsed.inbox.debounce_ms).toBe(200);
  });

  it("rejects empty project names", () => {
    expect(() => parseCognitConfig({ project: { name: "" } })).toThrow();
  });

  it("rejects overlong project names", () => {
    const longName = "x".repeat(129);
    expect(() => parseCognitConfig({ project: { name: longName } })).toThrow();
  });

  describe("llm block", () => {
    it("defaults api_key_env to AI_GATEWAY_API_KEY when llm omitted", () => {
      const cfg = defaultConfig("x");
      expect(cfg.llm.api_key_env).toBe("AI_GATEWAY_API_KEY");
      expect(cfg.llm.models).toEqual({});
      expect(cfg.llm.commands).toEqual({});
      expect(cfg.llm.default_model).toBeUndefined();
    });

    it("accepts the full spec §1 example", () => {
      const parsed = parseCognitConfig({
        project: { name: "x" },
        llm: {
          api_key_env: "AI_GATEWAY_API_KEY",
          default_model: "MiniMax/MiniMax-M3",
          models: {
            "anthropic/claude-sonnet-4-6": { api_key_env: "ANTHROPIC_API_KEY" },
            "glm/glm-4-plus": { api_key_env: "GLM_API_KEY" },
            "qwen/qwen-3-max": { api_key_env: "DASHSCOPE_API_KEY" },
            "openai/gpt-4o": { api_key_env: "OPENAI_API_KEY" },
          },
          commands: {
            ask: { model: "MiniMax/MiniMax-M3" },
            agent_run: { model: "anthropic/claude-sonnet-4-6" },
          },
        },
      });
      expect(parsed.llm.default_model).toBe("MiniMax/MiniMax-M3");
      expect(parsed.llm.models["anthropic/claude-sonnet-4-6"]?.api_key_env).toBe(
        "ANTHROPIC_API_KEY",
      );
      expect(parsed.llm.commands.ask?.model).toBe("MiniMax/MiniMax-M3");
      expect(parsed.llm.commands.agent_run?.model).toBe("anthropic/claude-sonnet-4-6");
    });

    it("rejects empty api_key_env", () => {
      expect(() =>
        parseCognitConfig({ project: { name: "x" }, llm: { api_key_env: "" } }),
      ).toThrow();
    });

    it("rejects empty default_model", () => {
      expect(() =>
        parseCognitConfig({ project: { name: "x" }, llm: { default_model: "" } }),
      ).toThrow();
    });

    it("rejects empty per-model api_key_env", () => {
      expect(() =>
        parseCognitConfig({
          project: { name: "x" },
          llm: { models: { "anthropic/claude-sonnet-4-6": { api_key_env: "" } } },
        }),
      ).toThrow();
    });

    it("accepts partial llm block (commands only)", () => {
      const parsed = parseCognitConfig({
        project: { name: "x" },
        llm: { commands: { ask: { model: "anthropic/claude-sonnet-4-6" } } },
      });
      expect(parsed.llm.api_key_env).toBe("AI_GATEWAY_API_KEY");
      expect(parsed.llm.commands.ask?.model).toBe("anthropic/claude-sonnet-4-6");
      expect(parsed.llm.commands.agent_run).toBeUndefined();
    });
  });
});
