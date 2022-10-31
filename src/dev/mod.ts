import {
  dirname,
  extname,
  fromFileUrl,
  gte,
  join,
  toFileUrl,
  walk,
} from "./deps.ts";
import { error } from "./error.ts";

const MIN_DENO_VERSION = "1.25.0";

export function ensureMinDenoVersion() {
  // Check that the minimum supported Deno version is being used.
  if (!gte(Deno.version.deno, MIN_DENO_VERSION)) {
    let message = `Deno version ${MIN_DENO_VERSION} or higher is required. Please update Deno.\n\n`;

    if (Deno.execPath().includes("homebrew")) {
      message +=
        "You seem to have installed Deno via homebrew. To update, run: `brew upgrade deno`\n";
    } else {
      message += "To update, run: `deno upgrade`\n";
    }

    error(message);
  }
}

interface Manifest {
  routes: string[];
  islands: string[];
}

export async function collect(directory: string): Promise<Manifest> {
  const routesDir = join(directory, "./routes");

  const routes = [];
  try {
    const routesUrl = toFileUrl(routesDir);
    // TODO(lucacasonato): remove the extranious Deno.readDir when
    // https://github.com/denoland/deno_std/issues/1310 is fixed.
    for await (const _ of Deno.readDir(routesDir)) {
      // do nothing
    }
    const routesFolder = walk(routesDir, {
      includeDirs: false,
      includeFiles: true,
      match: [/\/\+(page|middleware|app|layout|404|500)\.(tsx|jsx|ts|js)$/],
    });
    for await (const entry of routesFolder) {
      if (entry.isFile) {
        const file = toFileUrl(entry.path).href.substring(
          routesUrl.href.length
        );
        routes.push(file);
      }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      // Do nothing.
    } else {
      throw err;
    }
  }
  routes.sort();

  const islands = [];
  try {
    // const islandsUrl = toFileUrl(directory);
    const cwd = walk(directory, {
      includeDirs: false,
      includeFiles: true,
      match: [/\.island\.(tsx|jsx|ts|js)$/],
    });
    const cwdUrl = toFileUrl(directory);
    // for await (const entry of Deno.readDir(directory)) {
    for await (const entry of cwd) {
      if (entry.isFile) {
        const file = toFileUrl(entry.path).href.substring(cwdUrl.href.length);
        islands.push(file);
      }
      // // if (entry.isDirectory) {
      // //   error(
      // //     `Found subdirectory '${entry.name}' in islands/. The islands/ folder must not contain any subdirectories.`
      // //   );
      // // }
      // if (entry.isFile) {
      //   const ext = extname(entry.name);
      //   const prefix = entry.name.split(".").at(-2);
      //   console.log(entry);
      //   if (![".tsx", ".jsx", ".ts", ".js"].includes(ext) && prefix != "island")
      //     continue;
      //   const path = join(directory, entry.name);
      //   const file = toFileUrl(path).href.substring(
      //     toFileUrl(directory).href.length
      //   );
      //   islands.push(file);
      // }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      // Do nothing.
    } else {
      throw err;
    }
  }
  islands.sort();

  return { routes, islands };
}

export async function generate(directory: string, manifest: Manifest) {
  const { routes, islands } = manifest;

  const output = `// DO NOT EDIT. This file is generated by lemonade.
// This file SHOULD be checked into source version control.
// This file is automatically updated during development when running \`dev.ts\`.

import config from "./deno.json" assert { type: "json" };
${routes
  .map((file, i) => `import * as $${i} from "./routes${file}";`)
  .join("\n")}
${islands.map((file, i) => `import * as $$${i} from ".${file}";`).join("\n")}

const manifest = {
  routes: {
    ${routes
      .map(
        (file, i) =>
          `${JSON.stringify(
            `${file.substring(0, file.length - extname(file).length)}`
          )}: $${i},`
      )
      .join("\n    ")}
  },
  islands: {
    ${islands
      .map((file, i) => `${JSON.stringify(`.${file}`)}: $$${i},`)
      .join("\n    ")}
  },
  baseUrl: import.meta.url,
  config,
};

export default manifest;
`;

  const proc = Deno.run({
    cmd: [Deno.execPath(), "fmt", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  });
  const raw = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(output));
      controller.close();
    },
  });
  await raw.pipeTo(proc.stdin.writable);
  const out = await proc.output();
  await proc.status();
  proc.close();

  const manifestStr = new TextDecoder().decode(out);
  const manifestPath = join(directory, "./lemonade.gen.ts");

  await Deno.writeTextFile(manifestPath, manifestStr);
  console.log(
    `%cThe manifest has been generated for ${routes.length} routes and ${islands.length} islands.`,
    "color: blue; font-weight: bold"
  );
}

export async function dev(base: string, entrypoint: string) {
  ensureMinDenoVersion();

  entrypoint = new URL(entrypoint, base).href;

  const dir = dirname(fromFileUrl(base));

  let currentManifest: Manifest;
  const prevManifest = Deno.env.get("LEMON_DEV_PREVIOUS_MANIFEST");
  if (prevManifest) {
    currentManifest = JSON.parse(prevManifest);
  } else {
    currentManifest = { islands: [], routes: [] };
  }
  const newManifest = await collect(dir);
  Deno.env.set("LEMON_DEV_PREVIOUS_MANIFEST", JSON.stringify(newManifest));

  const manifestChanged =
    !arraysEqual(newManifest.routes, currentManifest.routes) ||
    !arraysEqual(newManifest.islands, currentManifest.islands);

  if (manifestChanged) await generate(dir, newManifest);

  Deno.env.set("LEMON_DEV", "1");

  await import(entrypoint);
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; ++i) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
