import { PrintSession } from './print-session';
import * as vscode from 'vscode';
import * as http from "http";
import * as dns from "dns";
import { AddressInfo } from 'net';
import * as path from "path";
import { captionByFilename, filenameByCaption, localise } from './imports';
import * as nls from 'vscode-nls';
import { SourceCode } from './source-code';

// #region necessary for vscode-nls-dev
const localize = nls.config({ messageFormat: nls.MessageFormat.file })();
// function localise(s: string): string { return localize(s, "x"); }
localize("NO_FILE", "x");
localize("UNSAVED_FILE", "x");
localize("EMPTY_SELECTION", "x");
localize("ERROR_PRINTING", "x");
localize("ACCESS_DENIED_CREATING_WEBSERVER", "x");
localize("UNEXPECTED_ERROR", "x");
// #endregion

let server: http.Server | undefined;

let colourScheme = vscode.workspace.getConfiguration("print", null).colourScheme;
if (captionByFilename[colourScheme]) {
	// legacy value, convert
	vscode.workspace.getConfiguration("print", null).update("colourScheme", captionByFilename[colourScheme]);
}
const printSessions = new Map<string, PrintSession>();

export function activate(context: vscode.ExtensionContext) {
	let ecmPrint = vscode.workspace.getConfiguration("print", null).editorContextMenuItemPosition,
		etmButton = vscode.workspace.getConfiguration("print", null).editorTitleMenuButton,
		disposable: vscode.Disposable;
	vscode.commands.executeCommand("setContext", "ecmPrint", ecmPrint);
	vscode.commands.executeCommand("setContext", "etmButton", etmButton);

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(checkConfigurationChange));
	context.subscriptions.push(vscode.commands.registerCommand("extension.print", printCommand));
	context.subscriptions.push(vscode.commands.registerCommand("extension.printFolder", printFolderCommand));

	// capture the extension path
	disposable = vscode.commands.registerCommand('extension.help', async (cmdArgs: any) => {
		let pathToManual = path.join(context.extensionPath, "manual.md");
		let uriManual: vscode.Uri = vscode.Uri.file(pathToManual);
		vscode.commands.executeCommand('markdown.showPreview', uriManual);
	});
	server = http.createServer(async (request, response) => {
		if (!connectingToLocalhost(request)) {
			return request.socket.end();
		}
		try {
			if (request.url) {
				const urlParts = request.url.split('/',);
				const printSession = printSessions.get(urlParts[1]);
				if (printSession) {
					await printSession.respond(urlParts, response);
				} else {
					return request.socket.end();
				}
			}
		} catch (error) {
			response.setHeader("Content-Type", "text/plain; charset=utf-8");
			response.end((error as any).stack);
		}
	});
	server.on("error", (err: any) => {
		if (err) {
			switch (err.code) {
				case "EACCES":
					vscode.window.showErrorMessage(localise("ACCESS_DENIED_CREATING_WEBSERVER"));
					break;
				default:
					vscode.window.showErrorMessage(`${localise("UNEXPECTED_ERROR")}: ${err.code}`);
			}
		}
	});
	server.on("listening", () => {
		PrintSession.port = (server!.address() as AddressInfo).port;
	});
	let printConfig = vscode.workspace.getConfiguration("print", null);
	server.listen();
	context.subscriptions.push(disposable);
	const markdownExtensionInstaller = {
		extendMarkdownIt(mdparam: any) {
			SourceCode.Markdown = mdparam;
			return mdparam;
		}
	};
	return markdownExtensionInstaller;
}

const checkConfigurationChange = (e: vscode.ConfigurationChangeEvent) => {
	if (e.affectsConfiguration('print.editorContextMenuItemPosition')) {
		vscode.commands.executeCommand(
			"setContext", "ecmPrint",
			vscode.workspace.getConfiguration("print", null)
				.get('editorContextMenuItemPosition'));
	}
	else if (e.affectsConfiguration('print.editorTitleMenuButton')) {
		vscode.commands.executeCommand(
			"setContext", "etmButton",
			vscode.workspace.getConfiguration("print", null)
				.get<boolean>('editorTitleMenuButton'));
	}
};

async function printCommand(cmdArgs: any) {
	Array.from(printSessions).forEach(ps => { if (ps[1].completed) printSessions.delete(ps[0]); });
	const printSession = new PrintSession(cmdArgs);
	printSessions.set(printSession.sessionId, printSession);
	printSession.launchBrowser()
}

async function printFolderCommand(commandArgs: any) {
	const editor = vscode.window.activeTextEditor;
	let folderUri: vscode.Uri;
	if (commandArgs) {
		folderUri = commandArgs;
	}
	else if (editor) {
		if (editor.document.isUntitled) {
			vscode.window.showErrorMessage(localise("UNSAVED_FILE"));
			return;
		}
		const cmdArgs = commandArgs as vscode.Uri;
		folderUri = vscode.Uri.from({
			scheme: cmdArgs.scheme,
			path: path.dirname(editor.document.uri.fsPath)
		});
	}
	else {
		vscode.window.showErrorMessage(localise("NO_SELECTION"));
		return;
	}
	Array.from(printSessions).forEach(ps => { if (ps[1].completed) printSessions.delete(ps[0]); });
	const printSession = new PrintSession(folderUri);
	printSessions.set(printSession.sessionId, printSession);
	printSession.launchBrowser()
}

export function deactivate() {
	server?.close();
}

const localhostAddresses: String[] = ["::1", "::ffff:127.0.0.1", "127.0.0.1"]
dns.lookup("localhost", { all: true, family: 4 }, (err, addresses) => {
	addresses
		.map(a => a.address)
		.filter(a => localhostAddresses.indexOf(a) < 0)
		.forEach(a => { localhostAddresses.push(a); localhostAddresses.push("::ffff:" + a); });
})
dns.lookup("localhost", { all: true, family: 6 }, (err, addresses) => {
	addresses
		.map(a => a.address)
		.filter(a => localhostAddresses.indexOf(a) < 0)
		.forEach(a => localhostAddresses.push(a));
})

function connectingToLocalhost(request: http.IncomingMessage): boolean {
	console.log(request.socket.localAddress)
	return localhostAddresses.indexOf(request.socket.localAddress!) >= 0;
}
