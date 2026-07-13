/**
 * Unit tests for exit code helpers (D-M2-01).
 */
import { describe, expect, it, afterEach } from "vitest";
import {
  EXIT_RUNTIME,
  EXIT_SUCCESS,
  EXIT_USAGE,
  exitCodeFromError,
  failRuntime,
  failUsage,
} from "../../src/exit.js";

afterEach(() => {
  process.exitCode = undefined;
});

describe("exit helpers", () => {
  it("failUsage sets code 2", () => {
    failUsage("bad args");
    expect(process.exitCode).toBe(EXIT_USAGE);
  });

  it("failRuntime sets code 1", () => {
    failRuntime("db exploded");
    expect(process.exitCode).toBe(EXIT_RUNTIME);
  });

  it("maps commander usage errors to 2", () => {
    expect(
      exitCodeFromError({
        code: "commander.missingArgument",
        exitCode: 1,
        message: "missing required argument",
      }),
    ).toBe(EXIT_USAGE);
  });

  it("maps help/version to success", () => {
    expect(
      exitCodeFromError({ code: "commander.helpDisplayed", exitCode: 0 }),
    ).toBe(EXIT_SUCCESS);
  });

  it("honours process.exitCode when already set", () => {
    process.exitCode = EXIT_USAGE;
    expect(exitCodeFromError(new Error("not in a cognit project"))).toBe(
      EXIT_USAGE,
    );
  });
});
