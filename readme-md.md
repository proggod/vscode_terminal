# VS Code Terminal Manager

Advanced terminal management for VS Code with smart command execution, output capturing, process monitoring, and workflow automation.

## Features

- **Terminal Management**: Create, reuse, and manage VS Code terminals by ID
- **Command Execution**: Run commands and capture their output programmatically
- **Input Detection**: Automatically detect commands waiting for user input
- **Workflow Automation**: Create and run multi-step terminal workflows
- **State Persistence**: Terminal history and state persist between VS Code sessions
- **Process Protection**: Kill hanging processes or handle input prompts automatically
- **Terminal Reuse**: Optimize terminal usage by reattaching to existing terminals

## Installation

1. Clone this repository to your VS Code extensions folder
2. Run `npm install` to install dependencies
3. Run `npm run compile` to build the extension
4. Restart VS Code

## Commands

The extension adds the following commands to VS Code:

- **Terminal Manager: Create New Terminal** - Create a new managed terminal
- **Terminal Manager: Show Terminal** - Show an existing managed terminal
- **Terminal Manager: Delete Terminal** - Delete a managed terminal
- **Terminal Manager: Run Command** - Run a command in a terminal
- **Terminal Manager: Run Command with Timeout** - Run a command with automatic timeout/kill
- **Terminal Manager: Kill Command** - Kill a running command
- **Terminal Manager: Show Menu** - Show the Terminal Manager menu
- **Terminal Manager: Create Workflow** - Create a new terminal workflow
- **Terminal Manager: Run Workflow** - Run an existing workflow
- **Terminal Manager: Delete Workflow** - Delete a workflow

## Using the API

You can use the Terminal Manager in your own extensions or scripts:

```typescript
import {
  createTerminal,
  runCommand,
  killCommand,
  deleteTerminal,
  getAllTerminalIds
} from 'vscode-terminal-manager';

// Create or reuse a terminal
const terminal = createTerminal('my-terminal', {
  cwd: '/path/to/project',
  env: { NODE_ENV: 'development' }
});

// Run a command and get the output
runCommand('my-terminal', 'npm install')
  .then(result => {
    console.log(`Command completed with code ${result.exitCode}`);
    console.log(`Output: ${result.output}`);
  });

// Kill a running command
killCommand('my-terminal');

// Delete a terminal
deleteTerminal('my-terminal');
```

## Configuration

The extension provides the following settings:

- **terminalManager.persistState**: Persist terminal state between VS Code sessions
- **terminalManager.autoKillHanging**: Automatically detect and prompt to kill commands waiting for input
- **terminalManager.inputWaitTimeout**: Timeout in milliseconds to detect commands waiting for input
- **terminalManager.showInStatusBar**: Show Terminal Manager in the status bar
- **terminalManager.defaultWorkingDirectory**: Default working directory for new terminals

## Advanced Usage

### Running Commands with Timeout

```typescript
import { runCommandWithTimeout } from 'vscode-terminal-manager';

// Run a command that will be automatically killed after 30 seconds
runCommandWithTimeout('my-terminal', 'npm run long-task', 30000)
  .then(result => {
    console.log('Command completed before timeout');
  })
  .catch(error => {
    console.log('Command was killed due to timeout');
  });

// You can also run multiple commands with different timeouts
async function runBuildWithTimeouts() {
  try {
    // Each command has its own timeout
    await runCommandWithTimeout('build-terminal', 'npm install', 120000); // 2 minutes
    await runCommandWithTimeout('build-terminal', 'npm run build', 60000); // 1 minute
    await runCommandWithTimeout('build-terminal', 'npm test', 30000); // 30 seconds
    console.log('All commands completed successfully');
  } catch (error) {
    console.error('A command timed out:', error.message);
  }
}
```

### Creating Workflows

Workflows allow you to run multiple commands sequentially:

```typescript
// Define workflow steps
const steps = [
  { name: 'build', command: 'npm run build' },
  { name: 'test', command: 'npm test' },
  { name: 'deploy', command: './deploy.sh' }
];

// Run workflow steps sequentially
async function runWorkflow() {
  const terminal = createTerminal('workflow');
  
  for (const step of steps) {
    try {
      await terminal.runCommand(step.command);
    } catch (error) {
      console.error(`Step ${step.name} failed:`, error);
      return;
    }
  }
  
  console.log('Workflow completed successfully!');
}
```

### Custom Input Wait Detection

```typescript
// Configure custom input wait detection
terminal.setInputWaitOptions({
  strategies: ['pattern', 'time'],
  waitThreshold: 10000, // 10 seconds
  promptPatterns: [
    /Continue\? \(y\/n\)/i,
    /Password:/i
  ],
  onDetected: 'prompt', // 'prompt', 'kill', 'ignore', 'callback'
  onInputWaitDetected: (terminal) => {
    // Custom handler for input wait detection
    vscode.window.showWarningMessage('Input prompt detected');
  }
});
```

## License

This project is licensed under the MIT License.
