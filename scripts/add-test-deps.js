const fs = require("node:fs");

for (const app of ["apps/sender", "apps/receiver"]) {
  const path = `${app}/package.json`;
  const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
  pkg.devDependencies = pkg.devDependencies || {};
  if (!pkg.devDependencies.ws) {
    pkg.devDependencies.ws = "^8.18.0";
  }
  if (!pkg.devDependencies["@msgpack/msgpack"]) {
    pkg.devDependencies["@msgpack/msgpack"] = "^3.0.1";
  }
  fs.writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`${app}: devDependencies updated`);
}
