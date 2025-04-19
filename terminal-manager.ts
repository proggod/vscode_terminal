/**
 * VS Code Terminal Manager
 *
 * A comprehensive TypeScript library for managing VS Code terminals.
 * Features:
 * - Create or reuse terminals by ID
 * - Run commands and capture output
 * - Detect commands waiting for input
 * - Automatic termination of hanging processes
 * - Command history and state persistence
 */

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';

// --------------- Types ---------------

/** Options for creating a terminal */
export interface TerminalOptions {
  /** Auto-show terminal when created */
  show?: boolean;
  /** Working directory for commands */
  cwd?: string;
  /** Environment variables to set */
  env?: Record<string, string>;
  /** Timeout in ms for detecting input waiting */
  inputWaitTimeout?: number;
  /** Enable automatic killing of hanging processes */
  autoKillHanging?: boolean;
  /** Terminal persistent state */
  persistState?: boolean;
}

/** Command execution options */
export interface CommandOptions {
  /** Timeout in ms (0 = no timeout) */
  timeout?: number;
  /** Hide command output in terminal */
  silent?: boolean;
  /** Callback for real-time output */
  onOutput?: (output: string, isError: boolean) => void;
  /** Callback for exit */
  onExit?: (code: number | null, output: string) => void;
  /** Auto-kill if input detected */
  killOnInputWait?: boolean;
  /** Custom working directory for this command */
  cwd?: string;
}

/** Command execution result */
export interface CommandResult {
  /** Exit code (null if process was killed) */
  exitCode: number | null;
  /** Complete output (stdout + stderr) */
  output: string;
  /** Command that was executed */
  command: string;
  /** Whether the process was killed */
  killed: boolean;
  /** Duration in milliseconds */
  duration: number;
}

/** Terminal state */
export interface TerminalState {
  /** Terminal ID */
  id: string;
  /** Command history */
  history: string[];
  /** Last working directory */
  lastCwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Whether terminal was visible */
  visible?: boolean;
}

/** Input waiting detection strategies */
export enum InputWaitStrategy {
  /** Detect based on time without output */
  TIME_BASED = 'time',
  /** Detect common prompt patterns */
  PATTERN_BASED = 'pattern',
  /** Detect process resource usage */
  RESOURCE_BASED = 'resource',
  /** Combine all strategies */
  ALL = 'all'
}

/** Options for input waiting detection */
export interface InputWaitOptions {
  /** Detection strategies to use */
  strategies?: InputWaitStrategy[];
  /** Time in ms to consider as input waiting */
  waitThreshold?: number;
  /** Custom prompt patterns to detect */
  promptPatterns?: RegExp[];
  /** Action to take when input waiting detected */
  onDetected?: 'prompt' | 'kill' | 'ignore' | 'callback';
  /** Callback when input waiting detected */
  onInputWaitDetected?: (terminal: ManagedTerminal) => void;
}

// Common prompt patterns that indicate waiting for user input
const DEFAULT_PROMPT_PATTERNS = [
  /\[\s*Y\/n\s*\](\s+)?$/i,  // [Y/n] prompt
  /\[\s*y\/N\s*\](\s+)?$/i,  // [y/N] prompt
  /\(y\/n\)(\s+)?$/i,        // (y/n) prompt
  /password:(\s+)?$/i,       // Password prompt
  /continue\?(\s+)?$/i,      // Continue? prompt
  /Press any key to continue/i, // Press any key
  /Press Enter to continue/i, // Press enter
  /Are you sure\?/i,         // Confirmation prompt
  />(\s+)?$/,                // Simple > prompt
];

// --------------- Terminal Class ---------------

/**
 * A custom pseudoterminal implementation for VS Code
 */
class CustomPseudoTerminal implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;

  private closeEmitter = new vscode.EventEmitter<number>();
  readonly onDidClose = this.closeEmitter.event;

  private resizeEmitter = new vscode.EventEmitter<vscode.TerminalDimensions>();
  readonly onDidResize = this.resizeEmitter.event;

  private _dimensions?: vscode.TerminalDimensions;
  private currentLine = '';
  private outputBuffer = '';
  private lastOutputLines: string[] = [];
  private lastOutputTime = Date.now();
  private currentProcess: ChildProcess | null = null;
  private inputWaitingTimeout: NodeJS.Timeout | null = null;
  private processStartTime = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private executingCommand = false;
  private activeCommandOptions: CommandOptions | null = null;

  constructor(
    private readonly parent: ManagedTerminal,
    private readonly options: TerminalOptions = {}
  ) {}

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    this._dimensions = initialDimensions;
    this.writeEmitter.fire(`Terminal ${this.parent.id} started\r\n`);
    this.writeEmitter.fire('$ ');
  }

  close(): void {
    this.killCurrentProcess();
    this.closeEmitter.fire(0);
  }

  handleInput(data: string): void {
    // If we have an active process, send input to it
    if (this.currentProcess && this.currentProcess.stdin) {
      // But only if it's not an arrow key
      if (data !== '\x1b[A' && data !== '\x1b[B') {
        this.currentProcess.stdin.write(data);
        this.writeEmitter.fire(data);
      }
      return;
    }

    // Handle special keys when no process is running
    switch (data) {
      case '\r': // Enter
        this.handleEnterKey();
        break;
      case '\x7f': // Backspace
        this.handleBackspace();
        break;
      case '\x1b[A': // Up arrow
        this.handleUpArrow();
        break;
      case '\x1b[B': // Down arrow
        this.handleDownArrow();
        break;
      default:
        this.currentLine += data;
        this.writeEmitter.fire(data);
        break;
    }
  }

  private handleEnterKey(): void {
    const command = this.currentLine.trim();
    this.writeEmitter.fire('\r\n');

    // Reset the current line immediately to avoid accumulation
    const savedCommand = command;
    this.currentLine = '';

    if (savedCommand) {
      this.history.push(savedCommand);
      this.historyIndex = this.history.length;
      this.parent.addToHistory(savedCommand);

      // Handle built-in commands
      if (savedCommand === 'clear' || savedCommand === 'cls') {
        this.writeEmitter.fire('\x1b[2J\x1b[3J\x1b[H');
        this.writeEmitter.fire('$ ');
      } else {
        this.executeCommand(savedCommand);
        return; // Don't show prompt yet
      }
    } else {
      this.writeEmitter.fire('$ ');
    }
  }

  private handleBackspace(): void {
    if (this.currentLine.length > 0) {
      this.currentLine = this.currentLine.substring(0, this.currentLine.length - 1);
      this.writeEmitter.fire('\b \b');
    }
  }

  private handleUpArrow(): void {
    if (this.history.length === 0 || this.historyIndex <= 0) return;

    // Clear current line
    for (let i = 0; i < this.currentLine.length; i++) {
      this.writeEmitter.fire('\b \b');
    }

    this.historyIndex--;
    this.currentLine = this.history[this.historyIndex];
    this.writeEmitter.fire(this.currentLine);
  }

  private handleDownArrow(): void {
    if (this.history.length === 0 || this.historyIndex >= this.history.length) return;

    // Clear current line
    for (let i = 0; i < this.currentLine.length; i++) {
      this.writeEmitter.fire('\b \b');
    }

    this.historyIndex++;

    if (this.historyIndex === this.history.length) {
      this.currentLine = '';
    } else {
      this.currentLine = this.history[this.historyIndex];
    }

    this.writeEmitter.fire(this.currentLine);
  }

  /**
   * Execute a command in the terminal
   */
  executeCommand(command: string, options: CommandOptions = {}): void {
    // Reset the current line to avoid command accumulation
    this.currentLine = command;

    // On macOS/Linux, we'll use the shell to execute the full command
    const useShell = true; // Always use shell for better compatibility
    const cmd = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
    const args = process.platform === 'win32' ? ['/c', command] : ['-c', command];

    // Prepare options
    this.activeCommandOptions = options;
    this.outputBuffer = '';
    this.executingCommand = true;

    if (!options.silent) {
      // Use proper CR+LF sequence for the executing message
      this.writeEmitter.fire(`Executing: ${command}\r\n`);
    }

    try {
      // Set spawn options
      const spawnOptions = {
        shell: false, // We're already using shell commands
        env: { ...process.env, ...(this.options.env || {}) },
        cwd: options.cwd || this.options.cwd || (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()),
        stdio: ['pipe', 'pipe', 'pipe'] as ('pipe' | 'ignore')[],
        // Important for process group killing on Unix:
        detached: process.platform !== 'win32'
      };

      // Start the process and timer
      this.currentProcess = spawn(cmd, args, spawnOptions);
      this.processStartTime = Date.now();
      this.setupProcessHandlers(options);

      // Setup timeout if specified
      if (options.timeout && options.timeout > 0) {
        setTimeout(() => {
          if (this.currentProcess) {
            if (!options.silent) {
              this.writeEmitter.fire('\r\nCommand timed out, killing process\r\n');
            }
            this.killCurrentProcess();
          }
        }, options.timeout);
      }

      // Start input detection if enabled
      if (this.options.autoKillHanging || options.killOnInputWait) {
        this.startInputDetection();
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Ensure proper line handling with CR+LF
      this.writeEmitter.fire(`\r\nError: ${errorMsg}\r\n`);
      this.activeCommandOptions = null;
      this.executingCommand = false;
      this.writeEmitter.fire('$ ');
    }
  }

  private setupProcessHandlers(options: CommandOptions): void {
    if (!this.currentProcess) return;

    // Handle stdout
    this.currentProcess.stdout?.on('data', (data) => {
      const output = data.toString();
      this.processOutput(output, false, options);
    });

    // Handle stderr
    this.currentProcess.stderr?.on('data', (data) => {
      const output = data.toString();
      this.processOutput(output, true, options);
    });

    // Handle process exit
    this.currentProcess.on('close', (code) => {
      this.stopInputDetection();

      const duration = Date.now() - this.processStartTime;
      const result: CommandResult = {
        exitCode: code,
        output: this.outputBuffer,
        command: options.silent ? '[hidden command]' : this.currentLine,
        killed: code === null,
        duration
      };

      // Notify parent terminal of command completion
      this.parent.onCommandFinished(result);

      // Call exit callback if provided
      if (options.onExit) {
        options.onExit(code, this.outputBuffer);
      }

      if (!options.silent) {
        if (code !== 0) {
          // Ensure proper line handling with CR+LF
          this.writeEmitter.fire(`\r\nProcess exited with code ${code}\r\n`);
        } else if (duration > 5000) {
          // Only show completion message for longer tasks
          this.writeEmitter.fire(`\r\nProcess completed in ${(duration / 1000).toFixed(1)}s\r\n`);
        } else {
          this.writeEmitter.fire('\r\n');
        }
      }

      this.currentProcess = null;
      this.activeCommandOptions = null;
      this.executingCommand = false;
      this.writeEmitter.fire('$ ');
    });

    // Handle process errors
    this.currentProcess.on('error', (err) => {
      this.stopInputDetection();

      if (!options.silent) {
        // Ensure proper line handling with CR+LF
        this.writeEmitter.fire(`\r\nProcess error: ${err.message}\r\n`);
      }

      const result: CommandResult = {
        exitCode: -1,
        output: this.outputBuffer,
        command: options.silent ? '[hidden command]' : this.currentLine,
        killed: false,
        duration: Date.now() - this.processStartTime
      };

      this.parent.onCommandFinished(result);

      if (options.onExit) {
        options.onExit(-1, this.outputBuffer);
      }

      this.currentProcess = null;
      this.activeCommandOptions = null;
      this.executingCommand = false;
      this.writeEmitter.fire('$ ');
    });
  }

  private processOutput(output: string, isError: boolean, options: CommandOptions): void {
    // Update timestamp for input waiting detection
    this.lastOutputTime = Date.now();

    // Store output
    this.outputBuffer += output;

    // Keep a buffer of the last few lines for input detection
    const lines = output.split(/\r?\n/);
    this.lastOutputLines = [...this.lastOutputLines, ...lines].slice(-10);

    // Call output callback if provided
    if (options.onOutput) {
      options.onOutput(output, isError);
    }

    // Write to terminal if not silent
    if (!options.silent) {
      // Ensure proper line handling by normalizing line endings
      // Replace all line feeds without carriage returns
      const normalizedOutput = output.replace(/([^\r])\n/g, '$1\r\n');
      this.writeEmitter.fire(normalizedOutput);
    }
  }

  /**
   * Start detection of processes waiting for input
   */
  private startInputDetection(): void {
    // Clear any existing timeout
    this.stopInputDetection();

    // Set initial output time
    this.lastOutputTime = Date.now();

    // Use custom timeout or default
    const checkInterval = 1000; // Check every second

    // Setup detection
    this.inputWaitingTimeout = setInterval(() => {
      if (!this.currentProcess) {
        this.stopInputDetection();
        return;
      }

      // Check if process is waiting for input
      const isWaiting = this.isWaitingForInput();

      if (isWaiting) {
        const options = this.parent.getInputWaitOptions();
        const action = options.onDetected || 'prompt';

        switch (action) {
          case 'kill':
            if (!this.activeCommandOptions?.silent) {
              this.writeEmitter.fire('\r\nProcess terminated: Detected waiting for input\r\n');
            }
            this.killCurrentProcess();
            break;

          case 'prompt':
            vscode.window.showWarningMessage(
              'Command may be waiting for input. Kill process?',
              'Yes', 'No'
            ).then(choice => {
              if (choice === 'Yes') {
                this.killCurrentProcess();
                if (!this.activeCommandOptions?.silent) {
                  this.writeEmitter.fire('\r\nProcess terminated by user\r\n');
                }
              }
            });
            break;

          case 'callback':
            if (options.onInputWaitDetected) {
              options.onInputWaitDetected(this.parent);
            }
            break;

          case 'ignore':
          default:
            // Do nothing
            break;
        }
      }
    }, checkInterval);
  }

  /**
   * Stop input waiting detection
   */
  private stopInputDetection(): void {
    if (this.inputWaitingTimeout) {
      clearInterval(this.inputWaitingTimeout);
      this.inputWaitingTimeout = null;
    }
  }

  /**
   * Detect if a process is waiting for user input
   */
  private isWaitingForInput(): boolean {
    if (!this.currentProcess) return false;

    const options = this.parent.getInputWaitOptions();
    const strategies = options.strategies || [InputWaitStrategy.ALL];
    const waitThreshold = options.waitThreshold || 5000; // 5 seconds default

    // Time-based detection
    const timeBased = () => {
      const timeSinceLastOutput = Date.now() - this.lastOutputTime;
      return timeSinceLastOutput > waitThreshold && this.currentProcess !== null;
    };

    // Pattern-based detection
    const patternBased = () => {
      // Combine default and custom patterns
      const patterns = [...DEFAULT_PROMPT_PATTERNS, ...(options.promptPatterns || [])];

      // Get last lines of output
      const lastLine = this.lastOutputLines[this.lastOutputLines.length - 1] || '';

      // Check if any prompt patterns match
      return patterns.some(pattern => pattern.test(lastLine));
    };

    // Resource-based detection (simplified)
    const resourceBased = () => {
      // In a real implementation, you'd check process CPU usage
      // For this example, we'll just use time-based as a fallback
      return timeBased();
    };

    // Check each strategy
    if (strategies.includes(InputWaitStrategy.ALL)) {
      // For ALL strategy, we use time-based plus either pattern or resource
      return timeBased() && (patternBased() || resourceBased());
    }

    // Check individual strategies
    let result = false;

    if (strategies.includes(InputWaitStrategy.TIME_BASED)) {
      result = result || timeBased();
    }

    if (strategies.includes(InputWaitStrategy.PATTERN_BASED)) {
      result = result || patternBased();
    }

    if (strategies.includes(InputWaitStrategy.RESOURCE_BASED)) {
      result = result || resourceBased();
    }

    return result;
  }

  /**
   * Kill the current process
   */
  killCurrentProcess(): boolean {
    if (!this.currentProcess) return false;

    try {
      // On Windows, use taskkill to kill the process tree
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', this.currentProcess.pid!.toString(), '/T', '/F']);
      } else {
        // On Unix, kill the process group
        if (this.currentProcess.pid) {
          process.kill(-this.currentProcess.pid, 'SIGKILL');
        }
      }

      this.currentProcess = null;
      this.stopInputDetection();
      return true;
    } catch (e) {
      // Process might be already dead
      console.error('Error killing process:', e);
      return false;
    }
  }

  /**
   * Write text to the terminal
   */
  write(text: string): void {
    this.writeEmitter.fire(text);
  }

  /**
   * Resize the terminal
   */
  resize(dimensions: vscode.TerminalDimensions): void {
    this._dimensions = dimensions;
    this.resizeEmitter.fire(dimensions);
  }

  /**
   * Get terminal dimensions
   */
  get dimensions(): vscode.TerminalDimensions | undefined {
    return this._dimensions;
  }

  /**
   * Get process status
   */
  get isProcessRunning(): boolean {
    return this.currentProcess !== null;
  }

  /**
   * Get state for persistence
   */
  getState(): any {
    return {
      history: this.history,
      lastCwd: this.options.cwd
    };
  }

  /**
   * Load state from persistence
   */
  loadState(state: any): void {
    if (state) {
      this.history = state.history || [];
      this.historyIndex = this.history.length;
    }
  }
}

// --------------- Terminal Manager ---------------

/**
 * Managed Terminal class
 */
export class ManagedTerminal {
  private pty: CustomPseudoTerminal;
  private vscodeTerminal: vscode.Terminal | null = null;
  private lastCommandResult: CommandResult | null = null;
  private commandPromises = new Map<string, { resolve: Function, reject: Function }>();
  private commandCounter = 0;
  private history: string[] = [];
  private outputChannel: vscode.OutputChannel | null = null;
  private inputWaitOptions: InputWaitOptions = {
    strategies: [InputWaitStrategy.ALL],
    waitThreshold: 5000,
    onDetected: 'prompt'
  };
  private disposed = false;

  constructor(
    public readonly id: string,
    private readonly options: TerminalOptions = {}
  ) {
    this.pty = new CustomPseudoTerminal(this, options);

    // Load state if persistence is enabled
    if (options.persistState) {
      const state = this.loadState();
      if (state) {
        this.history = state.history || [];
        this.pty.loadState(state);
      }
    }
  }

  /**
   * Get the VS Code terminal instance, creating it if necessary
   */
  getTerminal(): vscode.Terminal {
    if (this.disposed) {
      throw new Error(`Terminal ${this.id} has been disposed`);
    }

    if (!this.vscodeTerminal) {
      this.vscodeTerminal = vscode.window.createTerminal({
        name: this.id,
        pty: this.pty
      });

      // Set up terminal close handler
      const disposable = vscode.window.onDidCloseTerminal(terminal => {
        if (terminal === this.vscodeTerminal) {
          this.vscodeTerminal = null;

          // Save state if persistence is enabled
          if (this.options.persistState) {
            this.saveState();
          }

          disposable.dispose();
        }
      });
    }

    return this.vscodeTerminal;
  }

  /**
   * Show the terminal
   */
  show(): void {
    if (this.disposed) {
      throw new Error(`Terminal ${this.id} has been disposed`);
    }

    this.getTerminal().show();
  }

  /**
   * Hide the terminal
   */
  hide(): void {
    if (this.vscodeTerminal) {
      // VS Code doesn't have a direct hide API, so we need a workaround
      vscode.commands.executeCommand('workbench.action.terminal.focus');
      vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    }
  }

  /**
   * Dispose of the terminal
   */
  dispose(): void {
    if (this.vscodeTerminal) {
      this.vscodeTerminal.dispose();
      this.vscodeTerminal = null;
    }

    if (this.outputChannel) {
      this.outputChannel.dispose();
      this.outputChannel = null;
    }

    this.disposed = true;
  }

  /**
   * Run a command in the terminal
   */
  runCommand(command: string, options: CommandOptions = {}): Promise<CommandResult> {
    if (this.disposed) {
      return Promise.reject(new Error(`Terminal ${this.id} has been disposed`));
    }

    if (this.pty.isProcessRunning) {
      return Promise.reject(new Error('Another command is already running'));
    }

    return new Promise((resolve, reject) => {
      const commandId = `cmd_${++this.commandCounter}`;
      this.commandPromises.set(commandId, { resolve, reject });

      // Create a merged options object
      const mergedOptions: CommandOptions = {
        ...options,
        onExit: (code, output) => {
          if (options.onExit) {
            options.onExit(code, output);
          }

          const promise = this.commandPromises.get(commandId);
          if (promise) {
            this.commandPromises.delete(commandId);

            if (this.lastCommandResult) {
              promise.resolve(this.lastCommandResult);
            } else {
              promise.reject(new Error('Command execution failed with unknown error'));
            }
          }
        }
      };

      if (this.options.show !== false) {
        this.show();
      }

      // Log to output channel if we have one and logging is enabled
      if (this.outputChannel && !options.silent) {
        this.outputChannel.appendLine(`[${new Date().toISOString()}] Running: ${command}`);
      }

      this.pty.executeCommand(command, mergedOptions);
    });
  }

  /**
   * Run a command but don't wait for it to complete
   */
  runCommandNoWait(command: string, options: CommandOptions = {}): void {
    if (this.disposed) {
      throw new Error(`Terminal ${this.id} has been disposed`);
    }

    if (this.pty.isProcessRunning) {
      throw new Error('Another command is already running');
    }

    if (this.options.show !== false) {
      this.show();
    }

    this.pty.executeCommand(command, options);
  }

  /**
   * Kill the current command
   */
  killCommand(): boolean {
    return this.pty.killCurrentProcess();
  }

  /**
   * Write text to the terminal
   */
  write(text: string): void {
    if (this.disposed) {
      throw new Error(`Terminal ${this.id} has been disposed`);
    }

    this.pty.write(text);
  }

  /**
   * Clear the terminal
   */
  clear(): void {
    if (this.disposed) {
      throw new Error(`Terminal ${this.id} has been disposed`);
    }

    this.pty.write('\x1b[2J\x1b[3J\x1b[H');
  }

  /**
   * Get command history
   */
  getHistory(): string[] {
    return [...this.history];
  }

  /**
   * Add a command to history
   */
  addToHistory(command: string): void {
    this.history.push(command);

    // Limit history size
    const maxHistorySize = 100;
    if (this.history.length > maxHistorySize) {
      this.history = this.history.slice(-maxHistorySize);
    }
  }

  /**
   * Set input waiting detection options
   */
  setInputWaitOptions(options: InputWaitOptions): void {
    this.inputWaitOptions = { ...this.inputWaitOptions, ...options };
  }

  /**
   * Get input waiting detection options
   */
  getInputWaitOptions(): InputWaitOptions {
    return this.inputWaitOptions;
  }

  /**
   * Create or get an output channel for this terminal
   */
  getOutputChannel(): vscode.OutputChannel {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel(`Terminal: ${this.id}`);
    }
    return this.outputChannel;
  }

  /**
   * Called by the pseudoterminal when a command finishes
   */
  onCommandFinished(result: CommandResult): void {
    this.lastCommandResult = result;

    // Log to output channel if available
    if (this.outputChannel && !result.killed) {
      this.outputChannel.appendLine(`[${new Date().toISOString()}] Command completed with code ${result.exitCode}`);
      if (result.exitCode !== 0) {
        this.outputChannel.appendLine(result.output);
      }
    }
  }

  /**
   * Save terminal state
   */
  private saveState(): void {
    try {
      const state: TerminalState = {
        id: this.id,
        history: this.history,
        lastCwd: this.options.cwd,
        env: this.options.env,
        visible: !!this.vscodeTerminal
      };

      // Add PseudoTerminal state
      const ptyState = this.pty.getState();
      const mergedState = { ...state, ...ptyState };

      // Save to workspace state
      const key = `terminal-manager.terminal.${this.id}`;
      vscode.workspace.getConfiguration().update(key, mergedState, true);
    } catch (error) {
      console.error('Failed to save terminal state:', error);
    }
  }

  /**
   * Load terminal state
   */
  private loadState(): TerminalState | null {
    try {
      const key = `terminal-manager.terminal.${this.id}`;
      return vscode.workspace.getConfiguration().get(key) as TerminalState || null;
    } catch (error) {
      console.error('Failed to load terminal state:', error);
      return null;
    }
  }
}

// --------------- Terminal Manager ---------------

/**
 * Terminal Manager class for managing multiple terminals
 */
export class TerminalManager {
  private static instance: TerminalManager;
  private terminals = new Map<string, ManagedTerminal>();
  private defaultOptions: TerminalOptions = {
    show: true,
    persistState: true,
    autoKillHanging: true,
    inputWaitTimeout: 5000
  };

  /**
   * Get the singleton instance
   */
  static getInstance(): TerminalManager {
    if (!TerminalManager.instance) {
      TerminalManager.instance = new TerminalManager();
    }
    return TerminalManager.instance;
  }

  /**
   * Get or create a terminal by ID
   */
  getTerminal(id: string, options: TerminalOptions = {}): ManagedTerminal {
    // If terminal exists, return it
    if (this.terminals.has(id)) {
      const terminal = this.terminals.get(id)!;

      // Show if requested
      if (options.show !== false) {
        terminal.show();
      }

      return terminal;
    }

    // Create new terminal
    const mergedOptions = { ...this.defaultOptions, ...options };
    const terminal = new ManagedTerminal(id, mergedOptions);
    this.terminals.set(id, terminal);

    // Show if requested
    if (mergedOptions.show) {
      terminal.show();
    }

    return terminal;
  }

  /**
   * Set default options for all terminals
   */
  setDefaultOptions(options: TerminalOptions): void {
    this.defaultOptions = { ...this.defaultOptions, ...options };
  }

  /**
   * Get all terminals
   */
  getAllTerminals(): Map<string, ManagedTerminal> {
    return new Map(this.terminals);
  }

  /**
   * Get all terminal IDs
   */
  getAllTerminalIds(): string[] {
    return Array.from(this.terminals.keys());
  }

  /**
   * Check if a terminal exists
   */
  hasTerminal(id: string): boolean {
    return this.terminals.has(id);
  }

  /**
   * Delete a terminal by ID
   */
  deleteTerminal(id: string): boolean {
    if (this.terminals.has(id)) {
      const terminal = this.terminals.get(id)!;
      terminal.dispose();
      this.terminals.delete(id);
      return true;
    }
    return false;
  }

  /**
   * Delete all terminals
   */
  deleteAllTerminals(): void {
    for (const terminal of this.terminals.values()) {
      terminal.dispose();
    }
    this.terminals.clear();
  }

  /**
   * Run a command in a specific terminal
   */
  runCommand(terminalId: string, command: string, options: CommandOptions = {}): Promise<CommandResult> {
    const terminal = this.getTerminal(terminalId, options);
    return terminal.runCommand(command, options);
  }

  /**
   * Create an extension activation handler
   */
  createActivationHandler(): (context: vscode.ExtensionContext) => void {
    return (context: vscode.ExtensionContext) => {
      // Register commands
      context.subscriptions.push(
        vscode.commands.registerCommand('terminalManager.createTerminal', (id: string, options?: TerminalOptions) => {
          return this.getTerminal(id, options);
        })
      );

      context.subscriptions.push(
        vscode.commands.registerCommand('terminalManager.deleteTerminal', (id: string) => {
          return this.deleteTerminal(id);
        })
      );

      context.subscriptions.push(
        vscode.commands.registerCommand('terminalManager.runCommand',
          (terminalId: string, command: string, options?: CommandOptions) => {
            return this.runCommand(terminalId, command, options);
          }
        )
      );
    };
  }
}

// --------------- Utility Functions ---------------

/**
 * Create or reuse a terminal
 */
export function createTerminal(id: string, options: TerminalOptions = {}): ManagedTerminal {
  return TerminalManager.getInstance().getTerminal(id, options);
}

/**
 * Check if a terminal exists
 */
export function terminalExists(id: string): boolean {
  return TerminalManager.getInstance().hasTerminal(id);
}

/**
 * Delete a terminal
 */
export function deleteTerminal(id: string): boolean {
  return TerminalManager.getInstance().deleteTerminal(id);
}

/**
 * Run a command in a terminal
 */
export function runCommand(
  terminalId: string,
  command: string,
  options: CommandOptions = {}
): Promise<CommandResult> {
  return TerminalManager.getInstance().runCommand(terminalId, command, options);
}

/**
 * Run a command but don't wait for completion
 */
export function runCommandNoWait(
  terminalId: string,
  command: string,
  options: CommandOptions = {}
): void {
  const terminal = TerminalManager.getInstance().getTerminal(terminalId, options);
  terminal.runCommandNoWait(command, options);
}

/**
 * Kill a running command in a terminal
 */
export function killCommand(terminalId: string): boolean {
  if (!terminalExists(terminalId)) {
    return false;
  }

  const terminal = TerminalManager.getInstance().getTerminal(terminalId, { show: false });
  return terminal.killCommand();
}

/**
 * Get all terminal IDs
 */
export function getAllTerminalIds(): string[] {
  return TerminalManager.getInstance().getAllTerminalIds();
}

/**
 * Write text to a terminal
 */
export function writeToTerminal(terminalId: string, text: string): void {
  const terminal = TerminalManager.getInstance().getTerminal(terminalId, { show: false });
  terminal.write(text);
}

/**
 * Get command history from a terminal
 */
export function getTerminalHistory(terminalId: string): string[] {
  if (!terminalExists(terminalId)) {
    return [];
  }

  const terminal = TerminalManager.getInstance().getTerminal(terminalId, { show: false });
  return terminal.getHistory();
}

/**
 * Set default options for all terminals
 */
export function setDefaultTerminalOptions(options: TerminalOptions): void {
  TerminalManager.getInstance().setDefaultOptions(options);
}

// No need to re-export interfaces that are already exported above
