import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { VsCodeIde } from "./VsCodeIde";
import { captureTerminalCommand } from "./util/terminalOutput";

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
vi.mock("./util/terminalOutput", () => ({ captureTerminalCommand: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

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
});
