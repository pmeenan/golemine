import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const pnpmStorePath = path.join(root, "node_modules", ".pnpm");

const allowedLicenseIds = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "Zlib",
]);

const packageAllowlist = new Map([
  [
    "@isaacs/cliui",
    {
      licenses: new Set(["BlueOak-1.0.0"]),
      reason: "Transitive build-only dependency of workbox-build for PWA generation; not shipped as app code.",
    },
  ],
  [
    "@fontsource-variable/inter",
    {
      licenses: new Set(["OFL-1.1"]),
      reason: "Self-hosted Inter font asset package recorded in NOTICE.",
    },
  ],
  [
    "@fontsource-variable/jetbrains-mono",
    {
      licenses: new Set(["OFL-1.1"]),
      reason: "Self-hosted JetBrains Mono font asset package recorded in NOTICE.",
    },
  ],
  [
    "@sqlite.org/sqlite-wasm",
    {
      licenses: new Set(["Apache-2.0"]),
      reason: "Official sqlite-wasm package mandated by Architecture.md.",
    },
  ],
  [
    "argparse",
    {
      licenses: new Set(["Python-2.0"]),
      reason: "Permissive Python-2.0 command-line parser used only by build tooling.",
    },
  ],
  [
    "caniuse-lite",
    {
      licenses: new Set(["CC-BY-4.0"]),
      reason: "Browser compatibility dataset used only by build tooling.",
    },
  ],
  [
    "glob",
    {
      licenses: new Set(["BlueOak-1.0.0"]),
      reason: "Transitive build-only dependency of workbox-build for PWA generation; not shipped as app code.",
    },
  ],
  [
    "jackspeak",
    {
      licenses: new Set(["BlueOak-1.0.0"]),
      reason: "Transitive build-only dependency of workbox-build for PWA generation; not shipped as app code.",
    },
  ],
  [
    "lru-cache",
    {
      licenses: new Set(["BlueOak-1.0.0"]),
      reason: "Transitive build-only dependency of workbox-build for PWA generation; not shipped as app code.",
    },
  ],
  [
    "minimatch",
    {
      licenses: new Set(["BlueOak-1.0.0"]),
      reason: "Transitive build-only dependency of workbox-build for PWA generation; not shipped as app code.",
    },
  ],
  [
    "minipass",
    {
      licenses: new Set(["BlueOak-1.0.0"]),
      reason: "Transitive build-only dependency of workbox-build for PWA generation; not shipped as app code.",
    },
  ],
  [
    "package-json-from-dist",
    {
      licenses: new Set(["BlueOak-1.0.0"]),
      reason: "Transitive build-only dependency of workbox-build for PWA generation; not shipped as app code.",
    },
  ],
  [
    "path-scurry",
    {
      licenses: new Set(["BlueOak-1.0.0"]),
      reason: "Transitive build-only dependency of workbox-build for PWA generation; not shipped as app code.",
    },
  ],
]);

function licenseText(packageJson) {
  if (typeof packageJson.license === "string") {
    return packageJson.license.trim();
  }

  if (Array.isArray(packageJson.licenses)) {
    const licenseParts = packageJson.licenses
      .map((license) => {
        if (typeof license === "string") {
          return license.trim();
        }

        if (license && typeof license === "object" && typeof license.type === "string") {
          return license.type.trim();
        }

        return "";
      })
      .filter(Boolean);

    return licenseParts.join(" OR ");
  }

  return "";
}

function trimOuterParens(expression) {
  let trimmed = expression.trim();

  while (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    let depth = 0;
    let wrapsWholeExpression = true;

    for (let index = 0; index < trimmed.length; index += 1) {
      const character = trimmed[index];

      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
      }

      if (depth === 0 && index < trimmed.length - 1) {
        wrapsWholeExpression = false;
        break;
      }
    }

    if (!wrapsWholeExpression) {
      break;
    }

    trimmed = trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function splitTopLevel(expression, operator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  const needle = ` ${operator} `;

  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];

    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    }

    if (depth === 0 && expression.slice(index, index + needle.length) === needle) {
      parts.push(expression.slice(start, index));
      start = index + needle.length;
      index = start - 1;
    }
  }

  parts.push(expression.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function licenseExpressionIsAllowed(expression) {
  const trimmed = trimOuterParens(expression);

  if (trimmed === "") {
    return false;
  }

  const orParts = splitTopLevel(trimmed, "OR");
  if (orParts.length > 1) {
    return orParts.some(licenseExpressionIsAllowed);
  }

  const andParts = splitTopLevel(trimmed, "AND");
  if (andParts.length > 1) {
    return andParts.every(licenseExpressionIsAllowed);
  }

  if (trimmed.includes(" WITH ")) {
    return false;
  }

  return allowedLicenseIds.has(trimmed);
}

async function readJson(filePath) {
  const json = await readFile(filePath, "utf8");
  return JSON.parse(json);
}

async function readInstalledPackage(packagePath) {
  const packageJsonPath = path.join(packagePath, "package.json");
  const packageJson = await readJson(packageJsonPath);

  if (typeof packageJson.name !== "string" || typeof packageJson.version !== "string") {
    throw new Error(`${packageJsonPath} is missing name or version.`);
  }

  return {
    license: licenseText(packageJson),
    name: packageJson.name,
    path: packagePath,
    version: packageJson.version,
  };
}

async function collectInstalledPackages() {
  let storeEntries;

  try {
    storeEntries = await readdir(pnpmStorePath, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("node_modules/.pnpm is missing. Run pnpm install before auditing licenses.");
    }

    throw error;
  }

  const packages = new Map();

  for (const storeEntry of storeEntries) {
    if (!storeEntry.isDirectory() || storeEntry.name.startsWith(".")) {
      continue;
    }

    const nodeModulesPath = path.join(pnpmStorePath, storeEntry.name, "node_modules");
    let packageEntries;

    try {
      packageEntries = await readdir(nodeModulesPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const packageEntry of packageEntries) {
      if (!packageEntry.isDirectory()) {
        continue;
      }

      if (packageEntry.name.startsWith("@")) {
        const scopePath = path.join(nodeModulesPath, packageEntry.name);
        const scopedEntries = await readdir(scopePath, { withFileTypes: true });

        for (const scopedEntry of scopedEntries) {
          if (!scopedEntry.isDirectory()) {
            continue;
          }

          const packagePath = path.join(scopePath, scopedEntry.name);
          const installedPackage = await readInstalledPackage(packagePath);
          packages.set(`${installedPackage.name}@${installedPackage.version}`, installedPackage);
        }

        continue;
      }

      const packagePath = path.join(nodeModulesPath, packageEntry.name);
      const installedPackage = await readInstalledPackage(packagePath);
      packages.set(`${installedPackage.name}@${installedPackage.version}`, installedPackage);
    }
  }

  return [...packages.values()].sort((left, right) => {
    const nameComparison = left.name.localeCompare(right.name);

    if (nameComparison !== 0) {
      return nameComparison;
    }

    return left.version.localeCompare(right.version);
  });
}

const packages = await collectInstalledPackages();
const failures = [];
const allowlisted = [];

for (const installedPackage of packages) {
  const { license, name, version } = installedPackage;

  if (license === "") {
    failures.push(`${name}@${version}: missing license`);
    continue;
  }

  if (licenseExpressionIsAllowed(license)) {
    continue;
  }

  const allowlistEntry = packageAllowlist.get(name);

  if (allowlistEntry) {
    if (!allowlistEntry.licenses.has(license)) {
      failures.push(`${name}@${version}: ${license} (expected ${[...allowlistEntry.licenses].join(" OR ")})`);
      continue;
    }

    allowlisted.push(`${name}@${version}: ${license} (${allowlistEntry.reason})`);
    continue;
  }

  failures.push(`${name}@${version}: ${license}`);
}

if (failures.length > 0) {
  console.error("Disallowed or missing dependency licenses:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }

  console.error("\nAllowed license families: MIT, BSD-2/3, Apache-2.0, ISC, Zlib, 0BSD.");
  console.error("Non-code exceptions must be package-specific and documented in scripts/license-audit.mjs.");
  process.exit(1);
}

console.log(`Checked ${packages.length} installed dependency package versions.`);

if (allowlisted.length > 0) {
  console.log("Package-specific license exceptions:");
  for (const entry of allowlisted) {
    console.log(`- ${entry}`);
  }
}
