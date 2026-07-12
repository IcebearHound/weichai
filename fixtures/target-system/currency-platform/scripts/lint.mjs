import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const roots = ["src", "test"];
const violations = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
    } else if (entry.name.endsWith(".ts")) {
      const text = await readFile(path, "utf8");
      text.split(/\r?\n/u).forEach((line, index) => {
        if (/\s$/u.test(line)) violations.push(`${path}:${index + 1}: trailing whitespace`);
        if (line.includes("\t")) violations.push(`${path}:${index + 1}: tab character`);
        if (line.length > 120) violations.push(`${path}:${index + 1}: line exceeds 120 characters`);
      });
    }
  }
}

for (const root of roots) await walk(root);
if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("lint passed");
}
