import { describe, expect, it } from 'vitest';
import { defaultConfig, parseCognitConfig, CognitConfigSchema } from '../src/config.js';
import { Schema } from 'effect';

describe('cognit.yaml schema', () => {
  it('accepts the default config emitted by `cognit init`', () => {
    const cfg = defaultConfig('cognit');
    expect(cfg.project.name).toBe('cognit');
    expect(cfg.redaction.enabled).toBe(true);
    expect(cfg.session.snapshot_every_n_events).toBe(100);
    expect(cfg.actors.defaults.worker).toBe(0.6);
  });

  it('round-trips the schema through encode/decode', () => {
    const cfg = defaultConfig('roundtrip');
    const encoded = Schema.encodeSync(CognitConfigSchema)(cfg);
    const decoded = parseCognitConfig(encoded);
    expect(decoded.project.name).toBe('roundtrip');
    expect(decoded.inbox.atomic_write_required).toBe(true);
  });

  it('rejects invalid trust scores', () => {
    const bad = {
      project: { name: 'x' },
      actors: { defaults: { human: 1.5, worker: -0.1, system: 1.0 }, known: [] },
    };
    expect(() => parseCognitConfig(bad)).toThrow();
  });

  it('rejects unknown redaction action types', () => {
    const bad = {
      project: { name: 'x' },
      cleanup: { unreferenced_action: 'obliterate' },
    };
    expect(() => parseCognitConfig(bad)).toThrow();
  });

  it('applies defaults for omitted optional sections', () => {
    const minimal = { project: { name: 'x' } };
    const parsed = parseCognitConfig(minimal);
    expect(parsed.redaction.enabled).toBe(true);
    expect(parsed.inbox.watch).toBe(true);
    expect(parsed.inbox.debounce_ms).toBe(200);
  });

  it('rejects empty project names', () => {
    expect(() => parseCognitConfig({ project: { name: '' } })).toThrow();
  });

  it('rejects overlong project names', () => {
    const longName = 'x'.repeat(129);
    expect(() => parseCognitConfig({ project: { name: longName } })).toThrow();
  });
});
