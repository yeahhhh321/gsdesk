import fs from "node:fs";
import path from "node:path";

const root = path.join(process.cwd(), "src");
const rules = [
  { component: "Alert", pattern: /\bmessage\s*=/, replacement: "title" },
  { component: "Steps", pattern: /\bdirection\s*=/, replacement: "orientation" },
  { component: "Steps", pattern: /\blabelPlacement\s*=/, replacement: "titlePlacement" },
  { component: "Steps", pattern: /\bprogressDot\s*=/, replacement: 'type="dot"' },
  { component: "Steps", pattern: /\bsize\s*=\s*["']default["']/, replacement: 'size="medium"' },
];

const findings = [];
for (const file of collectSourceFiles(root)) {
  const content = fs.readFileSync(file, "utf8");
  for (const rule of rules) {
    const componentPattern = new RegExp(`<${rule.component}\\b[^>]*>`, "g");
    for (const match of content.matchAll(componentPattern)) {
      const snippet = match[0];
      if (!rule.pattern.test(snippet)) {
        continue;
      }
      findings.push({
        file,
        line: lineNumber(content, match.index ?? 0),
        component: rule.component,
        replacement: rule.replacement,
      });
    }
  }
}

if (findings.length) {
  for (const finding of findings) {
    const relative = path.relative(process.cwd(), finding.file);
    console.error(`[antd6] ${relative}:${finding.line} ${finding.component} 使用了已弃用属性，请改用 ${finding.replacement}`);
  }
  process.exit(1);
}

console.log("[antd6] deprecated prop checks passed");

function collectSourceFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (entry.isFile() && /\.(tsx|ts)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function lineNumber(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}
