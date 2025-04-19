/**
 * VS Code Terminal Manager - Usage Examples
 *
 * This file demonstrates how to use the Terminal Manager library in your VS Code extension.
 */

import * as vscode from 'vscode';
import {
  createTerminal,
  runCommand,
  runCommandNoWait,
  killCommand,
  deleteTerminal,
  terminalExists,
  getAllTerminalIds,
  writeToTerminal,
  getTerminalHistory,
  setDefaultTerminalOptions,
  CommandOptions,
  InputWaitStrategy
} from './terminal-manager';

// ------------------ Basic Usage ------------------

/**
 * Example 1: Simple terminal creation and command execution
 */
function basicExample() {
  // Create or reuse a terminal
  const terminal = createTerminal('my-terminal');

  // Run a command and get the result
  runCommand('my-terminal', 'echo "Hello World"')
    .then(result => {
      console.log(`Command completed with code ${result.exitCode}`);
      console.log(`Output: ${result.output}`);
    })
    .catch(error => {
      console.error('Command failed:', error);
    });
}

/**
 * Example 2: Running multiple commands sequentially
 */
async function sequentialCommands() {
  try {
    // Create terminal with specific options
    createTerminal('build-terminal', {
      cwd: '/path/to/project',
      env: { NODE_ENV: 'development' }
    });

    // Run commands one after another
    await runCommand('build-terminal', 'npm install');
    await runCommand('build-terminal', 'npm run build');
    await runCommand('build-terminal', 'npm test');

    // Show success message
    vscode.window.showInformationMessage('Build completed successfully!');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Build failed: ${errorMessage}`);
  }
}

/**
 * Example 3: Running a long-running command with timeout
 */
function longRunningCommand() {
  // Set command options
  const options: CommandOptions = {
    timeout: 60000, // 1 minute timeout
    onOutput: (output, isError) => {
      // Process real-time output
      if (isError) {
        console.error('Error output:', output);
      } else {
        console.log('Command output:', output);
      }
    }
  };

  // Run the command
  runCommand('server-terminal', 'npm start', options)
    .then(result => {
      console.log(`Server stopped after ${result.duration / 1000} seconds`);
    })
    .catch(error => {
      console.error('Server failed to start:', error);
    });
}

// ------------------ Advanced Usage ------------------

/**
 * Example 4: Handling commands that might hang or wait for input
 */
function handlePotentiallyHangingCommand() {
  // Create terminal with custom input wait detection
  const terminal = createTerminal('interactive-terminal', {
    autoKillHanging: true,
    inputWaitTimeout: 8000 // 8 seconds
  });

  // Configure input wait detection
  terminal.setInputWaitOptions({
    strategies: [InputWaitStrategy.PATTERN_BASED, InputWaitStrategy.TIME_BASED],
    waitThreshold: 10000, // 10 seconds
    promptPatterns: [/Continue\? \(y\/n\)/i, /Install\? \(Y\/n\)/i],
    onDetected: 'kill' // Automatically kill hanging processes
  });

  // Run potentially hanging command
  terminal.runCommand('npm install some-package')
    .then(result => {
      if (result.killed) {
        console.log('Command was killed because it was waiting for input');
      } else {
        console.log('Command completed successfully');
      }
    });
}

/**
 * Example 5: Running a task with progress reporting
 */
async function runTaskWithProgress() {
  // Show progress indicator
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Running deployment',
    cancellable: true
  }, async (progress, token) => {
    // Create terminal
    const terminal = createTerminal('deploy-terminal', { show: false });

    // Track if the user cancelled
    token.onCancellationRequested(() => {
      terminal.killCommand();
      vscode.window.showInformationMessage('Deployment cancelled');
    });

    // Define command options with progress reporting
    const options: CommandOptions = {
      onOutput: (output) => {
        // Parse output for progress updates
        if (output.includes('Uploading:')) {
          progress.report({ message: 'Uploading files...' });
        } else if (output.includes('Building:')) {
          progress.report({ message: 'Building application...' });
        } else if (output.includes('Testing:')) {
          progress.report({ message: 'Running tests...' });
        }
      }
    };

    try {
      // Run deployment command
      const result = await terminal.runCommand('./deploy.sh', options);

      if (result.exitCode === 0) {
        return vscode.window.showInformationMessage('Deployment completed successfully!');
      } else {
        return vscode.window.showErrorMessage(`Deployment failed with exit code ${result.exitCode}`);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return vscode.window.showErrorMessage(`Deployment error: ${errorMessage}`);
    }
  });
}

/**
 * Example 6: Multi-terminal workflow management
 */
class WorkflowManager {
  private terminals: Set<string> = new Set();

  constructor(private readonly workflowName: string) {}

  /**
   * Create a new terminal for this workflow
   */
  createWorkflowTerminal(name: string, options: any = {}): void {
    const terminalId = `${this.workflowName}-${name}`;
    createTerminal(terminalId, options);
    this.terminals.add(terminalId);
  }

  /**
   * Run a step in the workflow
   */
  async runStep(name: string, command: string, options: any = {}): Promise<any> {
    const terminalId = `${this.workflowName}-${name}`;

    // Create terminal if it doesn't exist
    if (!terminalExists(terminalId)) {
      this.createWorkflowTerminal(name, options);
    }

    // Run command
    return runCommand(terminalId, command, options);
  }

  /**
   * Clean up all terminals used in this workflow
   */
  cleanup(): void {
    for (const terminalId of this.terminals) {
      deleteTerminal(terminalId);
    }
    this.terminals.clear();
  }

  /**
   * Run a complete workflow
   */
  async runWorkflow(steps: Array<{ name: string, command: string, options?: any }>): Promise<void> {
    try {
      for (const step of steps) {
        await this.runStep(step.name, step.command, step.options);
      }
      vscode.window.showInformationMessage(`Workflow ${this.workflowName} completed successfully!`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Workflow ${this.workflowName} failed: ${errorMessage}`);
      // Don't clean up on failure so the user can inspect the terminals
    }
  }
}

// Example of using the workflow manager
function runDeploymentWorkflow() {
  const workflow = new WorkflowManager('deployment');

  workflow.runWorkflow([
    { name: 'build', command: 'npm run build', options: { cwd: './client' } },
    { name: 'test', command: 'npm test', options: { timeout: 30000 } },
    { name: 'deploy', command: './deploy.sh', options: { killOnInputWait: true } }
  ]).then(() => {
    // Cleanup after success
    workflow.cleanup();
  });
}

// ------------------ Extension Integration ------------------

/**
 * Example 7: Integrating with VS Code Extension activation
 */
export function activate(context: vscode.ExtensionContext) {
  // Set default options for all terminals
  setDefaultTerminalOptions({
    persistState: true,
    autoKillHanging: true
  });

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('myExtension.runBuild', () => {
      sequentialCommands();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('myExtension.startServer', () => {
      longRunningCommand();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('myExtension.deploy', () => {
      runTaskWithProgress();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('myExtension.runWorkflow', () => {
      runDeploymentWorkflow();
    })
  );

  // Command to kill all running processes
  context.subscriptions.push(
    vscode.commands.registerCommand('myExtension.killAll', () => {
      getAllTerminalIds().forEach(id => {
        killCommand(id);
      });
      vscode.window.showInformationMessage('Killed all running processes');
    })
  );
}

// ------------------ Practical Examples ------------------

/**
 * Example 8: Git operations across multiple repositories
 */
async function gitOperations() {
  const repos = [
    { name: 'frontend', path: '/path/to/frontend' },
    { name: 'backend', path: '/path/to/backend' },
    { name: 'common', path: '/path/to/common' }
  ];

  for (const repo of repos) {
    const terminalId = `git-${repo.name}`;

    // Create terminal with repo path as working directory
    createTerminal(terminalId, {
      cwd: repo.path,
      show: true // Show terminal so user can see progress
    });

    try {
      // Check for changes
      const statusResult = await runCommand(terminalId, 'git status --porcelain');

      if (statusResult.output.trim()) {
        // Has changes - show a message to the user
        const choice = await vscode.window.showInformationMessage(
          `Repository ${repo.name} has uncommitted changes. What would you like to do?`,
          'Commit & Push', 'Stash', 'Skip'
        );

        if (choice === 'Commit & Push') {
          await runCommand(terminalId, 'git add .');
          await runCommand(terminalId, 'git commit -m "Auto commit from VS Code extension"');
          await runCommand(terminalId, 'git push');
        } else if (choice === 'Stash') {
          await runCommand(terminalId, 'git stash save "Auto stash from VS Code extension"');
        }
      }

      // Pull latest changes
      await runCommand(terminalId, 'git pull');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Git operation failed in ${repo.name}: ${errorMessage}`);
    }
  }
}

/**
 * Example 9: Running tests with live output parsing
 */
function runTestsWithLiveAnalysis() {
  // Set up test output analysis
  const failingTests: string[] = [];
  const passingTests: string[] = [];

  // Regular expressions for test output
  const testStartRegex = /^\s*RUNNING\s+(.+)$/;
  const testPassRegex = /^\s*PASS\s+(.+)$/;
  const testFailRegex = /^\s*FAIL\s+(.+)$/;

  // Create terminal
  createTerminal('test-runner', {
    cwd: './tests',
    show: true
  });

  // Options for test command
  const options: CommandOptions = {
    onOutput: (output) => {
      // Split output into lines and process each line
      const lines = output.split('\n');

      for (const line of lines) {
        // Check for test status
        const failMatch = line.match(testFailRegex);
        if (failMatch) {
          failingTests.push(failMatch[1]);
          continue;
        }

        const passMatch = line.match(testPassRegex);
        if (passMatch) {
          passingTests.push(passMatch[1]);
        }
      }
    },
    onExit: (code, output) => {
      // Show test results summary
      if (code === 0) {
        vscode.window.showInformationMessage(`All tests passed: ${passingTests.length} tests`);
      } else {
        vscode.window.showErrorMessage(
          `Tests failed: ${failingTests.length} failing, ${passingTests.length} passing`
        );

        // Show detailed failure report
        const outputChannel = vscode.window.createOutputChannel('Test Results');
        outputChannel.appendLine('=== FAILING TESTS ===');
        failingTests.forEach(test => outputChannel.appendLine(`❌ ${test}`));
        outputChannel.appendLine('\n=== PASSING TESTS ===');
        passingTests.forEach(test => outputChannel.appendLine(`✅ ${test}`));
        outputChannel.show();
      }
    }
  };

  // Run the tests
  runCommand('test-runner', 'npm test', options);
}

/**
 * Example 10: Database operations with input protection
 */
function runDatabaseOperations() {
  // Create terminal for database operations
  const terminal = createTerminal('db-terminal', {
    cwd: './database',
    env: {
      DB_HOST: 'localhost',
      DB_USER: 'admin'
    }
  });

  // Setup input protection to prevent accidental data loss
  terminal.setInputWaitOptions({
    strategies: [InputWaitStrategy.PATTERN_BASED],
    promptPatterns: [
      /Are you sure you want to reset the database\? \(y\/N\)/i,
      /This will delete all data\. Continue\? \(y\/N\)/i,
      /Drop all tables\? \(y\/N\)/i
    ],
    onDetected: 'prompt', // Ask user before proceeding
    onInputWaitDetected: (terminal) => {
      vscode.window.showWarningMessage(
        'Database operation is asking for confirmation. This might be destructive.',
        'Proceed (Y)', 'Cancel'
      ).then(choice => {
        if (choice === 'Proceed (Y)') {
          writeToTerminal('db-terminal', 'y\r');
        } else {
          terminal.killCommand();
          vscode.window.showInformationMessage('Database operation cancelled');
        }
      });
    }
  });

  // Run database migration
  terminal.runCommand('./migrate.sh');
}
