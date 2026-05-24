import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveProjectContext, resolveRunWorkdir } from "../src/cli/index.js";

async function makeTempDir(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  return await fs.realpath(dir);
}

test("resolveProjectContext looks up LOOM_PROJECT by id or name from the v2 registry", async () => {
  const loomHome = await makeTempDir("loom-home");
  const alphaRoot = await makeTempDir("loom-alpha");
  const betaRoot = await makeTempDir("loom-beta");

  try {
    await fs.writeFile(
      path.join(loomHome, "workspace.json"),
      JSON.stringify({
        version: 2,
        projects: [
          { id: "proj_alpha", name: "alpha", root: alphaRoot },
          { id: "proj_beta", name: "beta", root: betaRoot },
        ],
      }),
      "utf8",
    );

    const byId = await resolveProjectContext({
      env: { LOOM_PROJECT: "proj_beta" },
      cwd: alphaRoot,
      loomHome,
    });
    assert.equal(byId.id, "proj_beta");
    assert.equal(byId.name, "beta");
    assert.equal(byId.root, betaRoot);
    assert.equal(byId.source, "registry");

    const byName = await resolveProjectContext({
      env: { LOOM_PROJECT: "alpha" },
      cwd: betaRoot,
      loomHome,
    });
    assert.equal(byName.id, "proj_alpha");
    assert.equal(byName.root, alphaRoot);
    assert.equal(byName.source, "registry");
  } finally {
    await fs.rm(loomHome, { recursive: true, force: true });
    await fs.rm(alphaRoot, { recursive: true, force: true });
    await fs.rm(betaRoot, { recursive: true, force: true });
  }
});

test("resolveProjectContext gives CLI project-root precedence and canonicalizes ad-hoc roots", async () => {
  const loomHome = await makeTempDir("loom-home");
  const envRoot = await makeTempDir("loom-env-project");
  const actualRoot = await makeTempDir("loom-adhoc-project");
  const symlinkParent = await makeTempDir("loom-links");
  const adHocAlias = path.join(symlinkParent, "adhoc-link");

  try {
    await fs.writeFile(
      path.join(loomHome, "workspace.json"),
      JSON.stringify({
        version: 2,
        projects: [{ id: "env_project", name: "env", root: envRoot }],
      }),
      "utf8",
    );
    await fs.symlink(actualRoot, adHocAlias);

    const project = await resolveProjectContext({
      projectRoot: adHocAlias,
      env: {
        LOOM_PROJECT: "env_project",
        LOOM_PROJECT_ROOT: envRoot,
      },
      cwd: envRoot,
      loomHome,
    });

    assert.equal(project.id, undefined);
    assert.equal(project.name, path.basename(actualRoot));
    assert.equal(project.root, actualRoot);
    assert.equal(project.source, "adhoc");
  } finally {
    await fs.rm(loomHome, { recursive: true, force: true });
    await fs.rm(envRoot, { recursive: true, force: true });
    await fs.rm(actualRoot, { recursive: true, force: true });
    await fs.rm(symlinkParent, { recursive: true, force: true });
  }
});

test("resolveProjectContext falls back to LOOM_PROJECT_ROOT and then cwd", async () => {
  const loomHome = await makeTempDir("loom-home");
  const envRoot = await makeTempDir("loom-env-root");
  const cwdRoot = await makeTempDir("loom-cwd-root");

  try {
    const fromEnvRoot = await resolveProjectContext({
      env: { LOOM_PROJECT_ROOT: envRoot },
      cwd: cwdRoot,
      loomHome,
    });
    assert.equal(fromEnvRoot.root, envRoot);
    assert.equal(fromEnvRoot.source, "adhoc");

    const fromCwd = await resolveProjectContext({
      env: {},
      cwd: cwdRoot,
      loomHome,
    });
    assert.equal(fromCwd.root, cwdRoot);
    assert.equal(fromCwd.source, "cwd");

    assert.equal(resolveRunWorkdir(undefined, envRoot), envRoot);
    assert.equal(resolveRunWorkdir("nested/path", envRoot), path.join(envRoot, "nested/path"));
  } finally {
    await fs.rm(loomHome, { recursive: true, force: true });
    await fs.rm(envRoot, { recursive: true, force: true });
    await fs.rm(cwdRoot, { recursive: true, force: true });
  }
});
