import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FilePatch } from "@forexplore/contracts";
import { BackfillAdapter } from "./backfill-adapter";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function modified(pathValue: string, original: string, replacement: string): FilePatch {
  return {
    path: pathValue,
    status: "modified",
    expectedOriginalSha256: hash(original),
    additions: 1,
    deletions: 1,
    hunks: [
      {
        header: "@@ -1,1 +1,1 @@",
        lines: [
          { type: "remove", content: original },
          { type: "add", content: replacement },
        ],
      },
    ],
  };
}

describe("BackfillAdapter", () => {
  let root: string;
  let adapter: BackfillAdapter;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "forexplore-backfill-"));
    roots.push(root);
    await mkdir(path.join(root, "src"));
    adapter = new BackfillAdapter({ projectRoot: root });
  });

  it("preflights, writes a checkpoint, and restores a matching file", async () => {
    const original = "old implementation";
    await writeFile(path.join(root, "src", "Service.cs"), original);

    const result = await adapter.apply([modified("src/Service.cs", original, "new implementation")]);

    expect(result.rollbackAvailable).toBe(true);
    expect(await readFile(path.join(root, "src", "Service.cs"), "utf8")).toBe("new implementation");

    await adapter.restore(result.checkpointId);
    expect(await readFile(path.join(root, "src", "Service.cs"), "utf8")).toBe(original);
  });

  it("rejects an empty write-back transaction", async () => {
    await expect(adapter.apply([])).rejects.toThrow("at least one patch");
  });

  it.each(["../outside.cs", "/tmp/outside.cs", "src/../../outside.cs"])(
    "rejects an escaping path %s before writing",
    async (unsafePath) => {
      const original = "old";
      await writeFile(path.join(root, "src", "Service.cs"), original);
      await expect(adapter.apply([modified(unsafePath, original, "new")])).rejects.toThrow("Patch path");
      expect(await readFile(path.join(root, "src", "Service.cs"), "utf8")).toBe(original);
    },
  );

  it("rejects a target that escapes through a symbolic link", async () => {
    if (process.platform === "win32") return;
    const outside = path.join(root, "..", `forexplore-outside-${Date.now()}.cs`);
    await writeFile(outside, "outside");
    try {
      await symlink(outside, path.join(root, "src", "Linked.cs"));
      await expect(adapter.apply([modified("src/Linked.cs", "outside", "new")])).rejects.toThrow(
        "escapes the project root",
      );
      expect(await readFile(outside, "utf8")).toBe("outside");
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("rejects a stale hash and leaves every file untouched", async () => {
    await writeFile(path.join(root, "src", "A.cs"), "actual-a");
    await writeFile(path.join(root, "src", "B.cs"), "actual-b");

    await expect(
      adapter.apply([
        modified("src/A.cs", "actual-a", "new-a"),
        modified("src/B.cs", "stale-b", "new-b"),
      ]),
    ).rejects.toThrow("changed since this migration run");

    expect(await readFile(path.join(root, "src", "A.cs"), "utf8")).toBe("actual-a");
    expect(await readFile(path.join(root, "src", "B.cs"), "utf8")).toBe("actual-b");
  });

  it("rejects a hunk whose remove content no longer matches", async () => {
    await writeFile(path.join(root, "src", "Service.cs"), "actual");
    const patch = modified("src/Service.cs", "actual", "new");
    patch.hunks[0]!.lines[0] = { type: "remove", content: "different" };

    await expect(adapter.apply([patch])).rejects.toThrow("no longer matches");
    expect(await readFile(path.join(root, "src", "Service.cs"), "utf8")).toBe("actual");
  });

  it("rejects a created file when its absence precondition is false", async () => {
    await writeFile(path.join(root, "src", "Existing.cs"), "existing");
    const patch: FilePatch = {
      path: "src/Existing.cs",
      status: "created",
      expectedAbsent: true,
      additions: 1,
      deletions: 0,
      hunks: [
        {
          header: "@@ -0,0 +1,1 @@",
          lines: [{ type: "add", content: "new" }],
        },
      ],
    };

    await expect(adapter.apply([patch])).rejects.toThrow("already exists");
    expect(await readFile(path.join(root, "src", "Existing.cs"), "utf8")).toBe("existing");
  });

  it("does not restore over an edit made after write-back", async () => {
    const original = "old";
    const file = path.join(root, "src", "Service.cs");
    await writeFile(file, original);
    const result = await adapter.apply([modified("src/Service.cs", original, "new")]);
    await writeFile(file, "user edit");

    await expect(adapter.restore(result.checkpointId)).rejects.toThrow("changed after");
    expect(await readFile(file, "utf8")).toBe("user edit");
  });
});
