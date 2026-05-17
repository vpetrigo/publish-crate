jest.mock("@actions/core", () => ({
  getInput: jest.fn(() => ""),
  getBooleanInput: jest.fn(() => false),
  info: jest.fn(),
  exportVariable: jest.fn(),
  setFailed: jest.fn(),
}));

jest.mock("@actions/exec", () => ({
  exec: jest.fn(async () => 0),
}));

jest.mock("@actions/io", () => ({
  which: jest.fn(async () => "/usr/bin/cargo"),
}));

import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as io from "@actions/io";
import * as path from "path";

import { install, checkForModifiedPackages, run } from "../src";

type MockedModule<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ?
        | ReturnType<typeof jest.fn<A, Promise<R>>>
        | ReturnType<typeof jest.fn<A, R>>
    : T[K];
};

const mockedCore = core as unknown as MockedModule<typeof core>;
const mockedExec = exec as unknown as MockedModule<typeof exec>;
const mockedIo = io as unknown as MockedModule<typeof io>;

beforeEach(() => {
  jest.resetAllMocks();
  mockedCore.getBooleanInput.mockImplementation(() => false);
  mockedCore.getInput.mockImplementation(() => "");
});

function mockInputs(overrides: Record<string, string> = {}): void {
  const defaults: Record<string, string> = {
    token: "ghp_test_token",
    "registry-token": "reg_test_token",
    path: ".",
    args: "",
    "dry-run": "false",
    "check-repo": "true",
    "publish-delay": "",
    "no-verify": "false",
    "ignore-unpublished-changes": "false",
  };

  const inputs = { ...defaults, ...overrides };

  mockedCore.getInput.mockImplementation((name: string) => {
    return inputs[name] ?? "";
  });

  mockedCore.getBooleanInput.mockImplementation((name: string) => {
    const val = inputs[name];
    if (val === "true") return true;
    if (val === "false") return false;
    throw new TypeError(
      `Input does not meet YAML 1.2 "Core Schema" specification: ${name}`,
    );
  });
}

function simulateChangedListOutput(output: string): void {
  mockedExec.exec.mockImplementation(
    async (
      commandLine: string,
      args?: string[],
      options?: exec.ExecOptions,
    ): Promise<number> => {
      if (
        args &&
        args.includes("workspaces") &&
        args.includes("changed") &&
        args.includes("--error-on-empty")
      ) {
        if (options?.listeners?.stdout) {
          options.listeners.stdout(Buffer.from(output));
        }
      }
      return 0;
    },
  );
}

describe("install", () => {
  it("skips install when cargo-workspaces is already available", async () => {
    mockedExec.exec.mockResolvedValue(0);
    mockedIo.which.mockResolvedValue("/usr/bin/cargo");

    const result = await install();

    expect(mockedExec.exec).toHaveBeenCalledWith(
      "/usr/bin/cargo",
      ["workspaces", "--version"],
      {
        silent: true,
      },
    );
    expect(mockedExec.exec).not.toHaveBeenCalledWith(
      expect.any(String),
      ["install", "cargo-workspaces"],
      expect.any(Object),
    );
    expect(mockedIo.which).toHaveBeenCalledWith("cargo", true);
    expect(result).toBe("/usr/bin/cargo");
  });

  it("installs cargo-workspaces when not available and returns cargo path", async () => {
    let callCount = 0;
    mockedExec.exec.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("not installed");
      }
      return 0;
    });
    mockedIo.which.mockResolvedValue("/usr/bin/cargo");

    const result = await install();

    expect(mockedExec.exec).toHaveBeenCalledWith(
      "/usr/bin/cargo",
      ["workspaces", "--version"],
      {
        silent: true,
      },
    );
    expect(mockedExec.exec).toHaveBeenCalledWith("/usr/bin/cargo", [
      "install",
      "cargo-workspaces",
    ]);
    expect(mockedIo.which).toHaveBeenCalledTimes(2);
    expect(result).toBe("/usr/bin/cargo");
  });

  it("propagates errors when cargo-workspaces check and install both fail", async () => {
    mockedExec.exec.mockRejectedValue(new Error("cargo not found"));

    await expect(install()).rejects.toThrow("cargo not found");
  });

  it("propagates io.which errors when cargo is missing", async () => {
    mockedExec.exec.mockResolvedValue(0);
    mockedIo.which.mockRejectedValue(
      new Error("Unable to locate executable file: cargo"),
    );

    await expect(install()).rejects.toThrow(
      "Unable to locate executable file: cargo",
    );
  });
});

describe("checkForModifiedPackages", () => {
  it("returns true when packages have changed", async () => {
    simulateChangedListOutput("crate-a\ncrate-b\n");

    const result = await checkForModifiedPackages(
      "/usr/bin/cargo",
      "/workspace",
    );

    expect(result).toBe(true);
    expect(mockedCore.info).toHaveBeenCalledWith(
      expect.stringContaining("crate-a"),
    );
  });

  it("returns false when no packages changed (empty output)", async () => {
    simulateChangedListOutput("");

    const result = await checkForModifiedPackages(
      "/usr/bin/cargo",
      "/workspace",
    );

    expect(result).toBe(false);
    expect(mockedCore.info).not.toHaveBeenCalledWith(
      expect.stringContaining("Changed packages"),
    );
  });

  it("returns false when output is only whitespace", async () => {
    simulateChangedListOutput("   \n  \n  ");

    const result = await checkForModifiedPackages(
      "/usr/bin/cargo",
      "/workspace",
    );

    expect(result).toBe(false);
  });

  it("passes correct cwd and command args", async () => {
    simulateChangedListOutput("crate-x\n");

    await checkForModifiedPackages("/usr/bin/cargo", "/my/workspace");

    expect(mockedExec.exec).toHaveBeenCalledWith(
      "/usr/bin/cargo",
      ["workspaces", "changed", "--error-on-empty"],
      expect.objectContaining({ cwd: "/my/workspace" }),
    );
  });

  it("propagates exec errors", async () => {
    mockedExec.exec.mockRejectedValue(
      new Error("cargo workspaces not installed"),
    );

    await expect(
      checkForModifiedPackages("/usr/bin/cargo", "/workspace"),
    ).rejects.toThrow("cargo workspaces not installed");
  });
});

describe("run", () => {
  beforeEach(() => {
    mockedExec.exec.mockResolvedValue(0);
    mockedIo.which.mockResolvedValue("/usr/bin/cargo");
  });

  function getExecCalls(): Array<{
    command: string;
    args: string[] | undefined;
    options: exec.ExecOptions | undefined;
  }> {
    return (mockedExec.exec as any).mock.calls.map((call: any[]) => ({
      command: call[0] as string,
      args: call[1] as string[] | undefined,
      options: call[2] as exec.ExecOptions | undefined,
    }));
  }

  function findPublishCall():
    | {
        command: string;
        args: string[] | undefined;
        options: exec.ExecOptions | undefined;
      }
    | undefined {
    return getExecCalls().find((c) => c.args && c.args.includes("publish"));
  }

  describe("basic publish flow", () => {
    it("installs cargo-workspaces and publishes with default args", async () => {
      let callCount = 0;
      mockedExec.exec.mockImplementation(async (cmd, args, options) => {
        if (args && args.includes("workspaces") && args.includes("--version")) {
          throw new Error("not installed");
        }
        if (
          args &&
          args.includes("workspaces") &&
          args.includes("changed") &&
          args.includes("--error-on-empty")
        ) {
          if (options?.listeners?.stdout) {
            options.listeners.stdout(Buffer.from("my-crate\n"));
          }
        }
        callCount++;
        return 0;
      });
      mockInputs();

      await run();

      expect(mockedExec.exec).toHaveBeenCalledWith("/usr/bin/cargo", [
        "install",
        "cargo-workspaces",
      ]);

      const publishCall = findPublishCall();
      expect(publishCall).toBeDefined();
      expect(publishCall!.args).toContain("--yes");
      expect(publishCall!.args).toContain("--token");
      expect(publishCall!.args).toContain("reg_test_token");

      expect(mockedCore.info).toHaveBeenCalledWith(
        "Successfully published crates",
      );
    });

    it("sets GITHUB_TOKEN env variable", async () => {
      simulateChangedListOutput("my-crate\n");
      mockInputs({ token: "my_gh_token" });

      await run();

      expect(mockedCore.exportVariable).toHaveBeenCalledWith(
        "GITHUB_TOKEN",
        "my_gh_token",
      );
    });

    it("configures git user in the workspace", async () => {
      simulateChangedListOutput("my-crate\n");
      mockInputs({ path: "/my/crate" });

      await run();

      const workspace = path.resolve("/my/crate");
      const gitCalls = getExecCalls().filter((c) => c.command === "git");

      expect(gitCalls).toHaveLength(2);
      expect(gitCalls[0].args).toEqual([
        "config",
        "user.name",
        "github-actions[bot]",
      ]);
      expect(gitCalls[0].options?.cwd).toBe(workspace);
      expect(gitCalls[1].args).toEqual([
        "config",
        "user.email",
        "github-actions[bot]@users.noreply.github.com",
      ]);
      expect(gitCalls[1].options?.cwd).toBe(workspace);
    });
  });

  describe("check-repo behavior", () => {
    it("fails when check-repo=true and no packages changed", async () => {
      simulateChangedListOutput("");
      mockInputs({ "check-repo": "true" });

      await run();

      expect(mockedCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining("No packages have changed"),
      );
    });

    it("exits gracefully when no changes and ignore-unpublished-changes=true", async () => {
      simulateChangedListOutput("");
      mockInputs({
        "check-repo": "true",
        "ignore-unpublished-changes": "true",
      });

      await run();

      expect(mockedCore.setFailed).not.toHaveBeenCalled();
      expect(mockedCore.info).toHaveBeenCalledWith(
        expect.stringContaining("Exiting gracefully"),
      );
    });

    it("skips change check when check-repo=false", async () => {
      mockedExec.exec.mockResolvedValue(0);
      mockInputs({ "check-repo": "false" });

      await run();

      const changedListCall = getExecCalls().find(
        (c) => c.args && c.args.includes("changed"),
      );
      expect(changedListCall).toBeUndefined();

      const publishCall = findPublishCall();
      expect(publishCall).toBeDefined();
    });
  });

  describe("registry-token handling", () => {
    it("includes --token when not dry-run and token is provided", async () => {
      simulateChangedListOutput("crate\n");
      mockInputs({
        "dry-run": "false",
        "registry-token": "my_registry_token",
      });

      await run();

      const publishCall = findPublishCall();
      expect(publishCall!.args).toContain("--token");
      expect(publishCall!.args).toContain("my_registry_token");
    });

    it("omits --token in dry-run mode even if token is provided", async () => {
      simulateChangedListOutput("crate\n");
      mockInputs({
        "dry-run": "true",
        "registry-token": "my_registry_token",
      });

      await run();

      const publishCall = findPublishCall();
      expect(publishCall!.args).not.toContain("--token");
      expect(publishCall!.args).toContain("--dry-run");
    });

    it("omits --token when registry-token is empty", async () => {
      simulateChangedListOutput("crate\n");
      mockInputs({ "registry-token": "" });

      await run();

      const publishCall = findPublishCall();
      expect(publishCall!.args).not.toContain("--token");
    });
  });

  describe("dry-run flag", () => {
    it("adds --dry-run to publish args", async () => {
      simulateChangedListOutput("crate\n");
      mockInputs({ "dry-run": "true" });

      await run();

      const publishCall = findPublishCall();
      expect(publishCall!.args).toContain("--dry-run");
    });

    it("does not add --dry-run when false", async () => {
      simulateChangedListOutput("crate\n");
      mockInputs({ "dry-run": "false" });

      await run();

      const publishCall = findPublishCall();
      expect(publishCall!.args).not.toContain("--dry-run");
    });
  });

  describe("no-verify flag", () => {
    it("adds --no-verify to publish args when true", async () => {
      simulateChangedListOutput("crate\n");
      mockInputs({ "no-verify": "true" });

      await run();

      const publishCall = findPublishCall();
      expect(publishCall!.args).toContain("--no-verify");
    });

    it("does not add --no-verify when false", async () => {
      simulateChangedListOutput("crate\n");
      mockInputs({ "no-verify": "false" });

      await run();

      const publishCall = findPublishCall();
      expect(publishCall!.args).not.toContain("--no-verify");
    });
  });

  describe("publish-delay", () => {
    it("converts milliseconds to seconds for --publish-interval", async () => {
      simulateChangedListOutput("crate\n");
      mockInputs({ "publish-delay": "5000" });

      await run();

      const publishCall = findPublishCall();
      expect(publishCall!.args).toContain("--publish-interval");
      expect(publishCall!.args).toContain("5");
    });

    it("rounds up fractional seconds (ceil)", async () => {
      simulateChangedListOutput("crate\n");
      mockInputs({ "publish-delay": "1500" });

      await run();

      const publishCall = findPublishCall();
      expect(publishCall!.args).toContain("--publish-interval");
      expect(publishCall!.args).toContain("2");
    });

    it("handles sub-second delay (rounds up to 1)", async () => {
      simulateChangedListOutput("crate\n");
      mockInputs({ "publish-delay": "100" });

      await run();

      const publishCall = findPublishCall();
      expect(publishCall!.args).toContain("--publish-interval");
      expect(publishCall!.args).toContain("1");
    });

    it("omits --publish-interval when publish-delay is empty", async () => {
      simulateChangedListOutput("crate\n");
      mockInputs({ "publish-delay": "" });

      await run();

      const publishCall = findPublishCall();
      expect(publishCall!.args).not.toContain("--publish-interval");
    });

    it("fails on invalid (non-numeric) publish-delay", async () => {
      simulateChangedListOutput("crate\n");
      mockInputs({ "publish-delay": "abc" });

      await run();

      expect(mockedCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining("Invalid publish-delay value: abc"),
      );
    });

    it("fails on negative publish-delay", async () => {
      simulateChangedListOutput("crate\n");
      mockInputs({ "publish-delay": "-1000" });

      await run();

      expect(mockedCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining("Invalid publish-delay value: -1000"),
      );
    });
  });

  describe("extra args", () => {
    it("appends extra args to publish command", async () => {
      simulateChangedListOutput("crate\n");
      mockInputs({ args: "--allow-dirty --no-git-push" });

      await run();

      const publishCall = findPublishCall();
      expect(publishCall!.args).toContain("--allow-dirty");
      expect(publishCall!.args).toContain("--no-git-push");
    });

    it("handles multiple whitespace between args", async () => {
      simulateChangedListOutput("crate\n");
      mockInputs({ args: "  --allow-dirty   --no-git-push  " });

      await run();

      const publishCall = findPublishCall();
      expect(publishCall!.args).toContain("--allow-dirty");
      expect(publishCall!.args).toContain("--no-git-push");
      expect(publishCall!.args).not.toContain("");
    });

    it("does not append when args is empty", async () => {
      simulateChangedListOutput("crate\n");
      mockInputs({ args: "" });

      await run();

      const publishCall = findPublishCall();
      const baseArgs = [
        "workspaces",
        "publish",
        "--yes",
        "--token",
        "reg_test_token",
      ];
      expect(publishCall!.args).toEqual(baseArgs);
    });
  });

  describe("combined flags", () => {
    it("includes all flags when everything is enabled", async () => {
      simulateChangedListOutput("crate\n");
      mockInputs({
        "dry-run": "true",
        "no-verify": "true",
        "publish-delay": "3000",
        args: "--allow-dirty",
        "registry-token": "tok123",
      });

      await run();

      const publishCall = findPublishCall();
      const publishArgs = publishCall!.args!;
      expect(publishArgs).toContain("--dry-run");
      expect(publishArgs).toContain("--no-verify");
      expect(publishArgs).toContain("--publish-interval");
      expect(publishArgs).toContain("3");
      expect(publishArgs).toContain("--allow-dirty");
      expect(publishArgs).not.toContain("--token");
    });
  });

  describe("error handling", () => {
    it("calls setFailed with Error message on Error instances", async () => {
      simulateChangedListOutput("crate\n");
      mockInputs();
      mockedExec.exec.mockImplementation(
        async (cmd: string, args?: string[]): Promise<number> => {
          if (args && args.includes("publish")) {
            throw new Error("publish failed: rate limited");
          }
          if (args && args.includes("changed") && args.includes("list")) {
            return 0;
          }
          return 0;
        },
      );

      mockedExec.exec.mockImplementation(
        async (
          cmd: string,
          args?: string[],
          options?: exec.ExecOptions,
        ): Promise<number> => {
          if (args && args.includes("workspaces") && args.includes("changed")) {
            if (options?.listeners?.stdout) {
              options.listeners.stdout(Buffer.from("crate\n"));
            }
            return 0;
          }
          if (args && args.includes("publish")) {
            throw new Error("publish failed: rate limited");
          }
          return 0;
        },
      );

      await run();

      expect(mockedCore.setFailed).toHaveBeenCalledWith(
        "publish failed: rate limited",
      );
    });

    it("calls setFailed with generic message for non-Error throws", async () => {
      mockedCore.getInput.mockImplementation(() => {
        throw "string error";
      });
      mockedCore.getBooleanInput.mockImplementation(() => {
        throw new TypeError("mocked");
      });

      await run();

      expect(mockedCore.setFailed).toHaveBeenCalledWith(
        "An unexpected error occurred",
      );
    });
  });

  describe("workspace path resolution", () => {
    it("resolves relative path to absolute for cwd", async () => {
      simulateChangedListOutput("crate\n");
      mockInputs({ path: "my-crate" });

      await run();

      const publishCall = findPublishCall();
      expect(publishCall!.options?.cwd).toBe(path.resolve("my-crate"));
    });

    it("handles absolute path", async () => {
      simulateChangedListOutput("crate\n");
      const absolutePath =
        process.platform === "win32"
          ? "C:\\projects\\my-crate"
          : "/projects/my-crate";
      mockInputs({ path: absolutePath });

      await run();

      const publishCall = findPublishCall();
      expect(publishCall!.options?.cwd).toBe(path.resolve(absolutePath));
    });
  });
});
