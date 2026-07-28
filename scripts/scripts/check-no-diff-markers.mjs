diff --git a/scripts/check-no-diff-markers.mjs b/scripts/check-no-diff-markers.mjs
new file mode 100644
index 0000000000000000000000000000000000000000..3b9ccca04b8018a64b31ac37a224a50a152e20db
--- /dev/null
+++ b/scripts/check-no-diff-markers.mjs
@@ -0,0 +1,23 @@
+import { readFileSync } from "node:fs";
+import { relative, resolve } from "node:path";
+
+const repoRoot = resolve(import.meta.dirname, "..");
+const sourceFiles = [
+  "src/app/api/registrations/route.ts",
+];
+
+const diffMarkerPattern = /^(diff --git|index [0-9a-f]+\.\.[0-9a-f]+|--- [ab]\/.+|\+\+\+ [ab]\/.+)/m;
+
+const corruptedFiles = sourceFiles.filter((file) => {
+  const content = readFileSync(resolve(repoRoot, file), "utf8");
+  return diffMarkerPattern.test(content);
+});
+
+if (corruptedFiles.length > 0) {
+  console.error("Build stopped: source file contains git diff/patch text instead of code:");
+  for (const file of corruptedFiles) {
+    console.error(`- ${relative(repoRoot, resolve(repoRoot, file))}`);
+  }
+  console.error("Replace the file contents with the actual TypeScript source, not the PR diff.");
+  process.exit(1);
+}
