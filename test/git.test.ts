import { describe, it, expect } from "vitest";
import { pickPullBranch, parseRemoteHeadBranch } from "../src/storage/git.js";

describe("git branch selection helpers", () => {
  it("prefers current branch when available", () => {
    expect(pickPullBranch("feature/x", "main")).toBe("feature/x");
  });

  it("falls back to remote HEAD when detached", () => {
    expect(pickPullBranch("HEAD", "main")).toBe("main");
    expect(pickPullBranch(null, "develop")).toBe("develop");
  });

  it("returns null when neither branch source is available", () => {
    expect(pickPullBranch(null, null)).toBeNull();
  });

  it("parses remote HEAD symbolic ref output", () => {
    expect(parseRemoteHeadBranch("refs/remotes/origin/main\n")).toBe("main");
    expect(parseRemoteHeadBranch("refs/remotes/upstream/develop")).toBe("develop");
    expect(parseRemoteHeadBranch("\n")).toBeNull();
  });
});
