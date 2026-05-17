import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as io from "@actions/io";
import * as path from "path";

export async function install(): Promise<string> {
  const cargoPath = await io.which("cargo", true);

  try {
    await exec.exec(cargoPath, ["workspaces", "--version"], {
      silent: true,
    });
    return cargoPath;
  } catch {
    await exec.exec(cargoPath, ["install", "cargo-workspaces"]);
    return io.which("cargo", true);
  }
}

export async function checkForModifiedPackages(
  cargo: string,
  workspace: string,
): Promise<boolean> {
  let output = "";

  const options: exec.ExecOptions = {
    cwd: workspace,
    listeners: {
      stdout: (data: Buffer) => {
        output += data.toString();
      },
    },
  };

  await exec.exec(
    cargo,
    ["workspaces", "changed", "--error-on-empty"],
    options,
  );

  const changedPackages = output.trim();

  if (changedPackages.length === 0) {
    return false;
  }

  core.info(`Changed packages:\n${changedPackages}`);
  return true;
}

export async function run(): Promise<void> {
  try {
    const token = core.getInput("token");
    const registryToken = core.getInput("registry-token");
    const cratePath = core.getInput("path");
    const args = core.getInput("args");
    const dryRun = core.getBooleanInput("dry-run");
    const checkRepo = core.getBooleanInput("check-repo");
    const publishDelay = core.getInput("publish-delay");
    const noVerify = core.getBooleanInput("no-verify");
    const ignoreUnpublishedChanges = core.getBooleanInput(
      "ignore-unpublished-changes",
    );

    const workspace = path.resolve(cratePath);

    core.info("Installing cargo-workspaces...");
    const cargo = await install();
    core.info("cargo-workspaces installed successfully");

    if (checkRepo) {
      core.info("Checking for modified packages...");
      const hasChanges = await checkForModifiedPackages(cargo, workspace);

      if (!hasChanges) {
        if (ignoreUnpublishedChanges) {
          core.info(
            "No packages have changed since last publish. Exiting gracefully.",
          );
          return;
        }

        core.setFailed(
          "No packages have changed since last publish. " +
            "Set ignore-unpublished-changes to true to exit gracefully.",
        );
        return;
      }
    }

    const publishArgs = ["workspaces", "publish", "--yes"];

    if (!dryRun && registryToken) {
      publishArgs.push("--token", registryToken);
    }

    if (noVerify) {
      publishArgs.push("--no-verify");
    }

    if (publishDelay) {
      const delayMs = parseInt(publishDelay, 10);

      if (isNaN(delayMs) || delayMs < 0) {
        core.setFailed(`Invalid publish-delay value: ${publishDelay}`);
        return;
      }

      // cargo-workspaces uses seconds for --publish-interval
      const delaySec = Math.ceil(delayMs / 1000);
      publishArgs.push("--publish-interval", delaySec.toString());
    }

    if (dryRun) {
      publishArgs.push("--dry-run");
    }

    if (args) {
      publishArgs.push(...args.split(/\s+/).filter(Boolean));
    }

    await exec.exec("git", ["config", "user.name", "github-actions[bot]"], {
      cwd: workspace,
    });
    await exec.exec(
      "git",
      ["config", "user.email", "github-actions[bot]@users.noreply.github.com"],
      { cwd: workspace },
    );

    core.exportVariable("GITHUB_TOKEN", token);

    core.info(`Publishing with: cargo ${publishArgs.join(" ")}`);

    await exec.exec(cargo, publishArgs, { cwd: workspace });

    core.info("Successfully published crates");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}

if (!process.env.JEST_WORKER_ID && !process.env.BUN_TEST) {
  run();
}
