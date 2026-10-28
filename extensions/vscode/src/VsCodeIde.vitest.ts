import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { VsCodeIde } from "./VsCodeIde";
import {
  captureTerminalCommand,
  waitForTerminalStartup,
} from "./util/terminalOutput";

vi.mock("vscode", () => ({
  window: { createTerminal: vi.fn() },
  Uri: { parse: vi.fn((value: string) => ({ value })) },
}));
vi.mock("core/util/constants", () => ({ EXTENSION_NAME: "Continue" }));
vi.mock("core/indexing/ignore", () => ({
  DEFAULT_IGNORES: [],
  defaultIgnoresGlob: "",
}));
vi.mock("./autocomplete/lsp", () => ({}));
vi.mock("./stubs/SecretStorage", () => ({}));
vi.mock("./util/ideUtils", () => ({}));
vi.mock("./util/util", () => ({}));
vi.mock("./util/vscode", () => ({}));
vi.mock("./util/terminalOutput", () => ({
  captureTerminalCommand: vi.fn(),
  waitForTerminalStartup: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(vscode.window.createTerminal).mockReturnValue({
    show: vi.fn(),
    dispose: vi.fn(),
  } as unknown as vscode.Terminal);
});

describe("VS Code terminal capture creation", () => {
  it("shows foreground terminals without stealing focus and preserves capture and the remote cwd", async () => {
    const show = vi.fn();
    const terminal = { show } as unknown as vscode.Terminal;
    const result = { output: "CONTINUE_TEST", completed: true, exitCode: 0 };
    vi.mocked(vscode.window.createTerminal).mockReturnValue(terminal);
    vi.mocked(captureTerminalCommand).mockResolvedValue(result);
    const ide = Object.create(VsCodeIde.prototype) as VsCodeIde;
    const cwd = "vscode-remote://ssh-remote+host/home/user/project";
    expect(
      await ide.runCommandWithOutput("pwd && echo CONTINUE_TEST", cwd),
    ).toBe(result);
    expect(vscode.window.createTerminal).toHaveBeenCalledWith({
      name: "Continue",
      cwd: vscode.Uri.parse(cwd),
      hideFromUser: false,
    });
    expect(show).toHaveBeenCalledExactlyOnceWith(true);
    expect(captureTerminalCommand).toHaveBeenCalledWith(
      vscode.window,
      terminal,
      "pwd && echo CONTINUE_TEST",
      true,
    );
  });

  it("keeps background terminals visible", async () => {
    const ide = Object.create(VsCodeIde.prototype) as VsCodeIde;
    await ide.runCommandWithOutput("server", undefined, false);
    expect(vscode.window.createTerminal).toHaveBeenCalledWith({
      name: "Continue",
      cwd: undefined,
      hideFromUser: false,
    });
  });

  it.each([true, false])(
    "shows the terminal and waits for startup before dispatch (waitForCompletion=%s)",
    async (waitForCompletion) => {
      const show = vi.fn();
      const terminal = { show, dispose: vi.fn() } as unknown as vscode.Terminal;
      vi.mocked(vscode.window.createTerminal).mockReturnValue(terminal);
      let ready!: () => void;
      vi.mocked(waitForTerminalStartup).mockReturnValue(
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
      );
      const ide = Object.create(VsCodeIde.prototype) as VsCodeIde;
      const result = ide.runCommandWithOutput(
        "true",
        undefined,
        waitForCompletion,
      );
      expect(show).toHaveBeenCalledExactlyOnceWith(true);
      expect(waitForTerminalStartup).toHaveBeenCalledWith(
        vscode.window,
        terminal,
      );
      expect(show.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(waitForTerminalStartup).mock.invocationCallOrder[0],
      );
      expect(captureTerminalCommand).not.toHaveBeenCalled();
      ready();
      await result;
      expect(captureTerminalCommand).toHaveBeenCalledExactlyOnceWith(
        vscode.window,
        terminal,
        "true",
        waitForCompletion,
      );
    },
  );

  it("does not dispatch when the terminal closes during startup", async () => {
    const dispose = vi.fn();
    vi.mocked(vscode.window.createTerminal).mockReturnValue({
      show: vi.fn(),
      dispose,
    } as unknown as vscode.Terminal);
    vi.mocked(waitForTerminalStartup).mockRejectedValue(
      new Error("Terminal closed before command execution"),
    );
    const ide = Object.create(VsCodeIde.prototype) as VsCodeIde;
    await expect(ide.runCommandWithOutput("true")).rejects.toThrow(
      "Terminal closed",
    );
    expect(captureTerminalCommand).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
