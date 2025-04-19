/**
 * VS Code Terminal Manager Extension Implementation
 *
 * A complete VS Code extension that implements the Terminal Manager.
 */

import * as vscode from 'vscode';
import {
  TerminalManager,
  createTerminal,
  runCommand,
  killCommand,
  deleteTerminal,
  getAllTerminalIds,
  CommandOptions,
  InputWaitStrategy
} from './terminal-manager';

// Extension activation
export function activate(context: vscode.ExtensionContext) {
  console.log('Terminal Manager extension is now active!');

  // Create status bar item
  globalStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  globalStatusBarItem.text = "$(terminal) Terminals";
  globalStatusBarItem.tooltip = "Manage VS Code Terminals";
  globalStatusBarItem.command = "terminalManager.showMenu";
  globalStatusBarItem.show();
  console.log('Status bar item created and shown');

  // Make sure to add the status bar item to subscriptions
  context.subscriptions.push(globalStatusBarItem);

  // Register commands

  // Create a new terminal
  context.subscriptions.push(
    vscode.commands.registerCommand('terminalManager.create', async () => {
      const terminalId = await vscode.window.showInputBox({
        placeHolder: 'Enter a unique terminal name',
        prompt: 'Create a new managed terminal'
      });

      if (terminalId) {
        createTerminal(terminalId, { show: true });
        vscode.window.showInformationMessage(`Terminal '${terminalId}' created`);
        updateStatusBar();
      }
    })
  );

  // Show terminal selector
  context.subscriptions.push(
    vscode.commands.registerCommand('terminalManager.show', async () => {
      const terminalIds = getAllTerminalIds();

      if (terminalIds.length === 0) {
        vscode.window.showInformationMessage('No managed terminals exist. Create one first.');
        vscode.commands.executeCommand('terminalManager.create');
        return;
      }

      const selected = await vscode.window.showQuickPick(terminalIds, {
        placeHolder: 'Select a terminal to show'
      });

      if (selected) {
        createTerminal(selected, { show: true });
      }
    })
  );

  // Delete terminal selector
  context.subscriptions.push(
    vscode.commands.registerCommand('terminalManager.delete', async () => {
      const terminalIds = getAllTerminalIds();

      if (terminalIds.length === 0) {
        vscode.window.showInformationMessage('No managed terminals exist.');
        return;
      }

      const selected = await vscode.window.showQuickPick(terminalIds, {
        placeHolder: 'Select a terminal to delete'
      });

      if (selected) {
        deleteTerminal(selected);
        vscode.window.showInformationMessage(`Terminal '${selected}' deleted`);
        updateStatusBar();
      }
    })
  );

  // Run command in terminal
  context.subscriptions.push(
    vscode.commands.registerCommand('terminalManager.runCommand', async () => {
      const terminalIds = getAllTerminalIds();

      if (terminalIds.length === 0) {
        vscode.window.showInformationMessage('No managed terminals exist. Create one first.');
        vscode.commands.executeCommand('terminalManager.create');
        return;
      }

      const selected = await vscode.window.showQuickPick(terminalIds, {
        placeHolder: 'Select a terminal to run command in'
      });

      if (!selected) return;

      const command = await vscode.window.showInputBox({
        placeHolder: 'Enter command to run',
        prompt: `Run command in terminal '${selected}'`
      });

      if (command) {
        try {
          runCommand(selected, command);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(`Error running command: ${errorMessage}`);
        }
      }
    })
  );

  // Kill command in terminal
  context.subscriptions.push(
    vscode.commands.registerCommand('terminalManager.killCommand', async () => {
      const terminalIds = getAllTerminalIds();

      if (terminalIds.length === 0) {
        vscode.window.showInformationMessage('No managed terminals exist.');
        return;
      }

      const selected = await vscode.window.showQuickPick(terminalIds, {
        placeHolder: 'Select a terminal to kill running command'
      });

      if (selected) {
        const killed = killCommand(selected);

        if (killed) {
          vscode.window.showInformationMessage(`Command in terminal '${selected}' was killed`);
        } else {
          vscode.window.showInformationMessage(`No running command in terminal '${selected}'`);
        }
      }
    })
  );

  // Show terminal manager menu
  context.subscriptions.push(
    vscode.commands.registerCommand('terminalManager.showMenu', async () => {
      const options = [
        { label: '$(plus) Create Terminal', command: 'terminalManager.create' },
        { label: '$(terminal) Show Terminal', command: 'terminalManager.show' },
        { label: '$(trash) Delete Terminal', command: 'terminalManager.delete' },
        { label: '$(run) Run Command', command: 'terminalManager.runCommand' },
        { label: '$(stop) Kill Command', command: 'terminalManager.killCommand' }
      ];

      const selected = await vscode.window.showQuickPick(options, {
        placeHolder: 'Terminal Manager'
      });

      if (selected) {
        vscode.commands.executeCommand(selected.command);
      }
    })
  );

  // Register advanced commands for workflow management
  registerWorkflowCommands(context);

  // Track terminal creation/deletion for status bar updates
  vscode.window.onDidOpenTerminal(() => updateStatusBar());
  vscode.window.onDidCloseTerminal(() => updateStatusBar());

  // Update status bar on activation
  updateStatusBar();

  // Return API for other extensions to use
  return {
    createTerminal,
    runCommand,
    killCommand,
    deleteTerminal,
    getAllTerminalIds,
    TerminalManager: TerminalManager.getInstance()
  };
}

// Global variable to store the status bar item
let globalStatusBarItem: vscode.StatusBarItem | undefined;

// Helper function to update the status bar
function updateStatusBar(): void {
  const terminalCount = getAllTerminalIds().length;

  // If we don't have a reference to the status bar item, create a new one
  if (!globalStatusBarItem) {
    globalStatusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    globalStatusBarItem.command = "terminalManager.showMenu";
  }

  // Update the status bar item
  globalStatusBarItem.text = `$(terminal) Terminals (${terminalCount})`;
  globalStatusBarItem.tooltip = "Manage VS Code Terminals";
  globalStatusBarItem.show();

  console.log(`Status bar updated: ${terminalCount} terminals`);
}

// Register workflow management commands
function registerWorkflowCommands(context: vscode.ExtensionContext): void {
  // Workflow configuration
  let workflows = context.workspaceState.get<any[]>('terminalManager.workflows') || [];

  // Create new workflow
  context.subscriptions.push(
    vscode.commands.registerCommand('terminalManager.createWorkflow', async () => {
      const name = await vscode.window.showInputBox({
        placeHolder: 'Enter workflow name',
        prompt: 'Create a new terminal workflow'
      });

      if (!name) return;

      const steps: any[] = [];
      let addMore = true;

      while (addMore) {
        const stepName = await vscode.window.showInputBox({
          placeHolder: 'Enter step name',
          prompt: `Add step to workflow '${name}'`
        });

        if (!stepName) break;

        const command = await vscode.window.showInputBox({
          placeHolder: 'Enter command for this step',
          prompt: `Command for step '${stepName}'`
        });

        if (!command) break;

        steps.push({ name: stepName, command });

        addMore = await vscode.window.showQuickPick(['Add another step', 'Finish'], {
          placeHolder: 'Add more steps?'
        }) === 'Add another step';
      }

      if (steps.length > 0) {
        workflows.push({ name, steps });
        await context.workspaceState.update('terminalManager.workflows', workflows);
        vscode.window.showInformationMessage(`Workflow '${name}' created with ${steps.length} steps`);
      }
    })
  );

  // Run workflow
  context.subscriptions.push(
    vscode.commands.registerCommand('terminalManager.runWorkflow', async () => {
      if (workflows.length === 0) {
        vscode.window.showInformationMessage('No workflows exist. Create one first.');
        vscode.commands.executeCommand('terminalManager.createWorkflow');
        return;
      }

      const selected = await vscode.window.showQuickPick(
        workflows.map(w => w.name),
        { placeHolder: 'Select workflow to run' }
      );

      if (!selected) return;

      const workflow = workflows.find(w => w.name === selected);

      if (!workflow) return;

      // Run workflow steps sequentially
      vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Running workflow '${workflow.name}'`,
        cancellable: true
      }, async (progress, token) => {
        const workflowTerminalId = `workflow-${workflow.name}`;
        createTerminal(workflowTerminalId, { show: true });

        // Handle cancellation
        token.onCancellationRequested(() => {
          killCommand(workflowTerminalId);
          vscode.window.showInformationMessage(`Workflow '${workflow.name}' cancelled`);
        });

        // Run each step
        for (let i = 0; i < workflow.steps.length; i++) {
          const step = workflow.steps[i];

          progress.report({
            message: `Step ${i+1}/${workflow.steps.length}: ${step.name}`,
            increment: (100 / workflow.steps.length)
          });

          try {
            // Run command with progress reporting
            await runCommand(workflowTerminalId, step.command, {
              onOutput: (output) => {
                // Could update progress details based on output if needed
              }
            });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(
              `Workflow step '${step.name}' failed: ${errorMessage}`
            );
            return;
          }
        }

        vscode.window.showInformationMessage(
          `Workflow '${workflow.name}' completed successfully!`
        );
      });
    })
  );

  // Delete workflow
  context.subscriptions.push(
    vscode.commands.registerCommand('terminalManager.deleteWorkflow', async () => {
      if (workflows.length === 0) {
        vscode.window.showInformationMessage('No workflows exist.');
        return;
      }

      const selected = await vscode.window.showQuickPick(
        workflows.map(w => w.name),
        { placeHolder: 'Select workflow to delete' }
      );

      if (!selected) return;

      workflows = workflows.filter(w => w.name !== selected);
      await context.workspaceState.update('terminalManager.workflows', workflows);

      vscode.window.showInformationMessage(`Workflow '${selected}' deleted`);
    })
  );
}

// Extension deactivation
export function deactivate() {
  // Clean up any resources
  const manager = TerminalManager.getInstance();

  // Optionally, kill all running processes or save state
  // We'll just log deactivation
  console.log('Terminal Manager Extension deactivated');
}
