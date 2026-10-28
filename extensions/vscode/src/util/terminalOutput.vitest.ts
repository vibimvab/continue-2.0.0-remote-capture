import { afterEach, describe, expect, it, vi } from "vitest";
import type { Event, Terminal } from "vscode";
import {
  captureTerminalCommand,
  ShellIntegrationWindow,
  waitForTerminalStartup,
} from "./terminalOutput";

function emitter<T>() {
  const listeners = new Set<(event: T) => void>();
  const event: Event<T> = (listener) => {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  };
  return {
    event,
    fire: (value: T) => listeners.forEach((fn) => fn(value)),
    listeners,
  };
}

type EventValue<T> = T extends Event<infer V> ? V : never;

function fixture(
  chunks = ["hello\r\n"],
  { exitCode }: { exitCode?: number } = { exitCode: 0 },
) {
  const end =
    emitter<
      EventValue<ShellIntegrationWindow["onDidEndTerminalShellExecution"]>
    >();
  const change =
    emitter<
      EventValue<ShellIntegrationWindow["onDidChangeTerminalShellIntegration"]>
    >();
  const close = emitter<Terminal>();
  const terminal = {
    show: vi.fn(),
    sendText: vi.fn(),
    dispose: vi.fn(),
    shellIntegration: {
      executeCommand: vi.fn(() => {
        const execution = {
          async *read() {
            for (const chunk of chunks) yield chunk;
            end.fire({
              terminal: terminal as unknown as Terminal,
              execution,
              exitCode,
            });
          },
        };
        return execution;
      }),
    },
  };
  const window: ShellIntegrationWindow = {
    onDidEndTerminalShellExecution: end.event,
    onDidChangeTerminalShellIntegration: change.event,
    onDidCloseTerminal: close.event,
  };
  return {
    terminal,
    window,
    end,
    change,
    close,
    run: (wait = true) =>
      captureTerminalCommand(
        window,
        terminal as unknown as Terminal,
        "echo hello",
        wait,
      ),
  };
}

afterEach(() => vi.useRealTimers());

describe("terminal startup grace period", () => {
  it("waits one second even when shell integration is already ready", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const ready = vi.fn();
    const result = waitForTerminalStartup(
      f.window,
      f.terminal as unknown as Terminal,
    ).then(ready);
    await vi.advanceTimersByTimeAsync(999);
    expect(ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(ready).toHaveBeenCalledOnce();
    expect(f.close.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows a delayed activation command to finish before dispatch", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const activation = vi.fn();
    setTimeout(activation, 300);
    const result = waitForTerminalStartup(
      f.window,
      f.terminal as unknown as Terminal,
    ).then(() => {
      expect(activation).toHaveBeenCalledOnce();
      f.terminal.sendText("true", true);
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(f.terminal.sendText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await result;
    expect(f.terminal.sendText).toHaveBeenCalledExactlyOnceWith("true", true);
  });

  it("cancels the wait and removes listeners when the terminal closes", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const result = expect(
      waitForTerminalStartup(f.window, f.terminal as unknown as Terminal),
    ).rejects.toThrow("Terminal closed");
    f.close.fire(f.terminal as unknown as Terminal);
    await result;
    expect(f.close.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores other terminals closing", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const result = waitForTerminalStartup(
      f.window,
      f.terminal as unknown as Terminal,
    );
    f.close.fire({} as Terminal);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBeUndefined();
  });

  it("does not wait on an already closed terminal", async () => {
    vi.useFakeTimers();
    const f = fixture();
    Object.assign(f.terminal, { exitStatus: { code: 0 } });
    await expect(
      waitForTerminalStartup(f.window, f.terminal as unknown as Terminal),
    ).rejects.toThrow("Terminal closed");
    expect(f.close.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("remote terminal output capture", () => {
  it("collects all chunks, strips only OSC markers and preserves ANSI colors", async () => {
    const f = fixture([
      "\x1b]633;A\x07\x1b[31mhe",
      "llo\x1b[0m\r\n\x1b]633;D;0\x1b\\",
      "]633;literal\n",
    ]);
    expect(await f.run()).toEqual({
      output: "\x1b[31mhello\x1b[0m\r\n]633;literal\n",
      completed: true,
      exitCode: 0,
    });
    expect(
      f.terminal.shellIntegration.executeCommand,
    ).toHaveBeenCalledExactlyOnceWith("echo hello");
    expect(f.terminal.sendText).not.toHaveBeenCalled();
    expect(f.terminal.dispose).toHaveBeenCalledOnce();
    expect(f.end.listeners.size + f.close.listeners.size).toBe(0);
  });

  it.each([7, undefined])(
    "returns the actual completion event exit code %s",
    async (exitCode) => {
      const f = fixture(["failure"], { exitCode });
      expect(await f.run()).toEqual({
        output: "failure",
        completed: true,
        exitCode,
      });
    },
  );

  it("waits for shell integration to become available", async () => {
    const f = fixture();
    const integration = f.terminal.shellIntegration;
    Object.assign(f.terminal, { shellIntegration: undefined });
    const result = f.run();
    f.change.fire({
      terminal: f.terminal as unknown as Terminal,
      shellIntegration: integration,
    });
    expect((await result).completed).toBe(true);
    expect(f.change.listeners.size).toBe(0);
  });

  it("sends the command once when shell integration times out", async () => {
    vi.useFakeTimers();
    const f = fixture();
    Object.assign(f.terminal, { shellIntegration: undefined });
    const result = f.run();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ completed: false });
    expect(f.terminal.sendText).toHaveBeenCalledExactlyOnceWith(
      "echo hello",
      true,
    );
    expect(f.terminal.dispose).not.toHaveBeenCalled();
    expect(f.change.listeners.size + f.close.listeners.size).toBe(0);
  });

  it("supports older VS Code without shell integration events", async () => {
    const f = fixture();
    f.window.onDidEndTerminalShellExecution = undefined;
    expect(await f.run()).toMatchObject({ completed: false });
    expect(f.terminal.sendText).toHaveBeenCalledExactlyOnceWith(
      "echo hello",
      true,
    );
    expect(f.terminal.shellIntegration.executeCommand).not.toHaveBeenCalled();
  });

  it("does not wait for or dispose background commands", async () => {
    const f = fixture();
    expect(await f.run(false)).toMatchObject({ completed: false });
    expect(f.terminal.sendText).toHaveBeenCalledExactlyOnceWith(
      "echo hello",
      true,
    );
    expect(f.terminal.shellIntegration.executeCommand).not.toHaveBeenCalled();
    expect(f.terminal.dispose).not.toHaveBeenCalled();
  });

  it("propagates read failures and cleans up without executing twice", async () => {
    const f = fixture();
    f.terminal.shellIntegration.executeCommand.mockImplementation(() => ({
      async *read() {
        throw new Error("read failed");
      },
    }));
    await expect(f.run()).rejects.toThrow("read failed");
    expect(f.terminal.dispose).toHaveBeenCalledOnce();
    expect(f.terminal.sendText).not.toHaveBeenCalled();
    expect(f.end.listeners.size + f.close.listeners.size).toBe(0);
  });

  it("times out a command that never finishes and disposes its terminal", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.terminal.shellIntegration.executeCommand.mockImplementation(() => ({
      async *read() {
        yield "still running";
        await new Promise(() => {});
      },
    }));
    const result = expect(f.run()).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(120_000);
    await result;
    expect(f.terminal.dispose).toHaveBeenCalledOnce();
    expect(f.end.listeners.size + f.close.listeners.size).toBe(0);
  });

  it("returns output when the stream ends but the exit event never arrives", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.terminal.shellIntegration.executeCommand.mockImplementation(() => ({
      async *read() {
        yield "CONTINUE_TEST\r\n";
      },
    }));
    const result = f.run();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toEqual({
      output: "CONTINUE_TEST\r\n",
      completed: true,
      exitCode: undefined,
    });
    expect(f.terminal.dispose).toHaveBeenCalledOnce();
    expect(f.end.listeners.size + f.close.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the deadline active when an exit event arrives but the stream stays open", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.terminal.shellIntegration.executeCommand.mockImplementation(() => {
      const execution = {
        async *read() {
          yield "CONTINUE_TEST\r\n";
          f.end.fire({
            terminal: f.terminal as unknown as Terminal,
            execution,
            exitCode: 0,
          });
          await new Promise(() => {});
        },
      };
      return execution;
    });
    const result = expect(f.run()).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(120_000);
    await result;
    expect(f.terminal.dispose).toHaveBeenCalledOnce();
    expect(f.end.listeners.size + f.close.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a terminal closed during execution", async () => {
    const f = fixture();
    f.terminal.shellIntegration.executeCommand.mockImplementation(() => ({
      async *read() {
        yield "partial";
      },
    }));
    const result = expect(f.run()).rejects.toThrow("Terminal closed");
    await Promise.resolve();
    f.close.fire(f.terminal as unknown as Terminal);
    await result;
    expect(f.terminal.dispose).toHaveBeenCalledOnce();
  });
});
