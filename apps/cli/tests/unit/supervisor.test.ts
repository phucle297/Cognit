import { describe, expect, it } from "vitest";
import {
  detectPlatform,
  generateLaunchdUnit,
  generateSystemdUnit,
} from "../../src/supervisor.js";

const WORKDIR = "/home/me/proj";

describe("detectPlatform", () => {
  it("returns one of the known families", () => {
    const p = detectPlatform();
    expect(["systemd", "launchd", "unknown"]).toContain(p);
  });
});

describe("generateSystemdUnit", () => {
  const unit = generateSystemdUnit({ workingDir: WORKDIR });

  it("runs as a user-mode service (no User=, default.target)", () => {
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).not.toContain("User=");
  });

  it("starts `cognit inbox --watch` with the working dir", () => {
    expect(unit).toContain(`WorkingDirectory=${WORKDIR}`);
    expect(unit).toContain("ExecStart=cognit inbox --watch");
  });

  it("restarts on failure with a backoff", () => {
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=5");
  });

  it("honours a custom cognit path", () => {
    const u = generateSystemdUnit({
      workingDir: WORKDIR,
      cognitPath: "/usr/local/bin/cognit",
    });
    expect(u).toContain("ExecStart=/usr/local/bin/cognit inbox --watch");
  });

  it("rejects a relative workingDir", () => {
    expect(() =>
      generateSystemdUnit({ workingDir: "relative/path" }),
    ).toThrow(/absolute/);
  });
});

describe("generateLaunchdUnit", () => {
  const plist = generateLaunchdUnit({ workingDir: WORKDIR });

  it("is a well-formed plist envelope", () => {
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain("<plist version=\"1.0\">");
    expect(plist.trim().endsWith("</plist>")).toBe(true);
  });

  it("passes `cognit inbox --watch` as ProgramArguments", () => {
    expect(plist).toContain("<key>ProgramArguments</key>");
    expect(plist).toMatch(/<string>cognit<\/string>/);
    expect(plist).toMatch(/<string>inbox<\/string>/);
    expect(plist).toMatch(/<string>--watch<\/string>/);
  });

  it("sets the working directory and keepalive flags", () => {
    expect(plist).toContain(`<string>${WORKDIR}</string>`);
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<true/>");
    expect(plist).toContain("<key>KeepAlive</key>");
  });

  it("writes logs under ~/.cognit/logs", () => {
    expect(plist).toContain("StandardOutPath");
    expect(plist).toContain("StandardErrorPath");
    expect(plist).toMatch(/\.cognit\/logs\/inbox-watch/);
  });
});
