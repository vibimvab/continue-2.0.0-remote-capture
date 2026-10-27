import type { TerminalCommandResult } from "core";
import type { Disposable, Event, Terminal } from "vscode";

// Shell integration was added in VS Code 1.93. Keep it optional so the
// extension still works with its supported older VS Code versions.
interface ShellExecution {
  read(): AsyncIterable<string>;
}

interface ShellIntegration {
  executeCommand(command: string): ShellExecution;
}

type IntegratedTerminal = Terminal & { shellIntegration?: ShellIntegration };

export interface ShellIntegrationWindow {
  onDidChangeTerminalShellIntegration?: Event<{
    terminal: IntegratedTerminal;
    shellIntegration: ShellIntegration;
  }>;
  onDidEndTerminalShellExecution?: Event<{
    terminal: Terminal;
    execution: ShellExecution;
    exitCode: number | undefined;
  }>;
  onDidCloseTerminal: Event<Terminal>;
}

function waitForShellIntegration(
  window: ShellIntegrationWindow,
  terminal: IntegratedTerminal,
): Promise<ShellIntegration | undefined> {
  if (terminal.shellIntegration) {
    return Promise.resolve(terminal.shellIntegration);
  }
  if (!window.onDidChangeTerminalShellIntegration) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    const subscriptions: Disposable[] = [];
    const cleanup = () => {
      clearTimeout(timeout);
      subscriptions.forEach((subscription) => subscription.dispose());
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, 10_000);
    subscriptions.push(
      window.onDidChangeTerminalShellIntegration!((event) => {
        if (event.terminal === terminal) {
          cleanup();
          resolve(event.shellIntegration);
        }
      }),
      window.onDidCloseTerminal((closed) => {
        if (closed === terminal) {
          cleanup();
          reject(new Error("Terminal closed before command execution"));
        }
      }),
    );
    if (terminal.shellIntegration) {
      cleanup();
      resolve(terminal.shellIntegration);
    }
  });
}

export async function captureTerminalCommand(
  window: ShellIntegrationWindow,
  terminal: IntegratedTerminal,
  command: string,
  waitForCompletion = true,
): Promise<TerminalCommandResult> {
  // Background commands must remain alive after this request returns.
  if (!waitForCompletion) {
    terminal.show();
    terminal.sendText(command, true);
    return {
      output:
        "Command sent to remote terminal. Output capture is disabled for background commands.",
      completed: false,
    };
  }

  const subscriptions: Disposable[] = [];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let exitEventGrace: ReturnType<typeof setTimeout> | undefined;
  let keepTerminal = false;
  try {
    const integration = window.onDidEndTerminalShellExecution
      ? await waitForShellIntegration(window, terminal)
      : undefined;
    if (!integration) {
      terminal.show();
      terminal.sendText(command, true);
      keepTerminal = true;
      return {
        output:
          "Command sent to remote terminal. Shell integration is unavailable; completion and output could not be captured.",
        completed: false,
      };
    }

    let execution: ShellExecution;
    // Register before executeCommand, and read immediately afterward as required
    // by the VS Code API. Exit codes arrive on the completion event, not read().
    const completion = new Promise<number | undefined>((resolve) => {
      subscriptions.push(
        window.onDidEndTerminalShellExecution!((event) => {
          if (event.execution === execution && event.terminal === terminal) {
            resolve(event.exitCode);
          }
        }),
      );
    });
    // Cover the entire capture operation. Rejecting the completion promise alone
    // cannot interrupt a hung read after that promise has already resolved.
    const interrupted = new Promise<never>((_resolve, reject) => {
      subscriptions.push(
        window.onDidCloseTerminal((closed) => {
          if (closed === terminal) {
            reject(new Error("Terminal closed before command completed"));
          }
        }),
      );
      timeout = setTimeout(() => {
        reject(new Error("Remote command timed out after 2 minutes"));
      }, 120_000);
    });

    execution = integration.executeCommand(command);
    const collectResult = async (): Promise<TerminalCommandResult> => {
      let output = "";
      for await (const chunk of execution.read()) {
        output += chunk;
      }
      // read() ends when execution finishes. Allow the exit event to follow the
      // final output, but do not wait another two minutes if that event is lost.
      // Report an unknown exit code rather than inventing a successful one.
      const exitCode = await Promise.race([
        completion,
        new Promise<undefined>((resolve) => {
          exitEventGrace = setTimeout(() => resolve(undefined), 1_000);
        }),
      ]);
      // Remove only complete VS Code OSC 633 markers (BEL or ST terminated).
      // Preserve ANSI colors and ordinary text containing "]633;".
      return {
        output: output.replace(/\x1b\]633;[^\x07\x1b]*(?:\x07|\x1b\\)/g, ""),
        exitCode,
        completed: true,
      };
    };
    return await Promise.race([collectResult(), interrupted]);
  } finally {
    clearTimeout(timeout);
    clearTimeout(exitEventGrace);
    subscriptions.forEach((subscription) => subscription.dispose());
    if (!keepTerminal) {
      terminal.dispose();
    }
  }
}
