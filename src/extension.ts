import { promisify } from "util";
import { exec } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";


const PREFIX = "goto://";
const HISTORY_KEY = 'file-history';

// From MDN
function escapeRegExp(v: string) {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


async function linkFromText(
  doc: vscode.TextDocument,
  text: string,
  begin: number,
  end: number)
{
  const linkText = text.substring(begin + PREFIX.length, end);

  let isEscape = false;
  const prefixes: string[] = [];
  const suffixes: string[] = [];
  let target = prefixes;
  let accumulated = "";
  for(let pos = 0; pos < linkText.length; pos ++) {
    const char = linkText[pos];
    if (char == "`") {
      isEscape = ! isEscape;
      if (accumulated.length && !isEscape) {
        if (target == prefixes) {
          try {
            let {stdout} = await promisify(exec)(accumulated);
            stdout  = stdout.trim();
            if (stdout.length && !stdout.includes("\n")) {
              target.push(stdout);
            }
          } catch (e) {
            // TODO: signal e.stderr on "go to link"?
          }
        }
        else {
          target.push(accumulated);
        }
        accumulated = "";
      }
    }
    else if (char == "#" && !isEscape) {
      if (accumulated.length) {
        target.push(accumulated);
        accumulated = "";
      }
      // Accumulate suffixes after the first #
      target = suffixes;
    }
    else {
      accumulated += char;
    }
  }
  if (accumulated.length) {
    target.push(accumulated);
  }

  const range = new vscode.Range(doc.positionAt(begin), doc.positionAt(end));
  let filepath = path.join(...prefixes);
  // Try to resolve location of relative path.
  if (filepath[0] !== '/') {
    filepath = path.resolve(path.dirname(doc.fileName), filepath);
  }
  const anchors = suffixes;
  if (suffixes) {
    return new vscode.DocumentLink(range,
      vscode.Uri.parse(`command:extension.goto-link-provider.open?${
        encodeURIComponent(JSON.stringify({filepath, anchors}))
      }`)
    );
  }
  else {
    try {
      await promisify(fs.stat)(filepath);
      // Open existing file reusing current editor tab if possible
      return new vscode.DocumentLink(range,
        vscode.Uri.parse(`command:extension.goto-link-provider.open?${
          encodeURIComponent(JSON.stringify({filepath}))
        }`)
      );
    } catch(e) {
      // If no anchor is specified use file:// uri so VSCode will ask
      // to create a file if it does not exists. This will use a new editor
      // tab.
      return new vscode.DocumentLink(range, vscode.Uri.file(filepath));
    }
  }
}


export function activate(context: vscode.ExtensionContext) {
  const dispose = (v: any) => context.subscriptions.push(v);

	dispose(vscode.languages.registerDocumentLinkProvider("*", {
    async provideDocumentLinks(doc, cancel) {
      const text = doc.getText();
      const links = [];
      let offset = 0;

      while (!cancel.isCancellationRequested) {
        const begin = text.indexOf(PREFIX, offset);
        if (begin == -1) break;
        let pos = begin + PREFIX.length

        let isEscape = false;
        for (; pos < text.length; pos ++) {
          const char = text[pos];
          if (char == "`") isEscape = ! isEscape;
          if (char == "\n") break;
          if ((char == " " || char == "\t") && !isEscape) break;
        }
        // Next search from the end of this one
        offset = pos;

        // Nothing found after "goto://"?
        if (pos <= begin + PREFIX.length) continue;
        links.push(await linkFromText(doc, text, begin, offset));
      }

      return links;
    }
  }));

  vscode.window.onDidChangeActiveTextEditor(e => {
    if (!e) return;
    if (!e.document) return;
    const filePath = e.document.fileName;
    let history: string[] | undefined = context.globalState.get(HISTORY_KEY);
    if (!Array.isArray(history)) history = [];
    // file path changed?
    if (history[history.length - 1] != filePath) {
      history.push(filePath);
      if (history.length > 100) history = history.slice(-100);
      context.globalState.update(HISTORY_KEY, history);
    }
  });

  const openCmdName = "extension.goto-link-provider.open";
  dispose(vscode.commands.registerCommand(openCmdName, (argmap) => {
    if (!argmap) return;
    const {filepath, anchors} = argmap;
    const uri = vscode.Uri.file(filepath);
    vscode.workspace.openTextDocument(uri).then(doc => {
      vscode.window.showTextDocument(doc).then(() => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        if (!Array.isArray(anchors)) return;
        let text = editor.document.getText().toLowerCase();
        let lastFoundIdx = null;
        let lastFoundSize = 0;
        for (const anchor of anchors) {
          const query = new RegExp(escapeRegExp(anchor), 'im');
          const match = text.match(query);
          //  Break on first not found and use last found index, if any
          if (!match || match.index == undefined) break;
          if (!lastFoundIdx) {
            lastFoundIdx = match.index;
          }
          else {
            //  We are searching remainaing text, so it's a relative index
            lastFoundIdx += lastFoundSize + match.index;
          }

          //  Remaining text
          lastFoundSize = match[0].length;
          text = text.slice(match.index + lastFoundSize);
        }

        if (lastFoundIdx) {
          const pos = editor.document.positionAt(lastFoundIdx);
          const range = new vscode.Range(pos, pos);
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
          const selection = new vscode.Selection(pos, pos);
          editor.selection = selection;
        }
      });
    });
  }));

  const backCmdName = "extension.goto-link-provider.back";
  dispose(vscode.commands.registerCommand(backCmdName, () => {
    const history = context.globalState.get(HISTORY_KEY);
    if (Array.isArray(history) && history.length > 1) {
      //  Current file.
      history.pop();
      //  Previous file
      const filePath = history[history.length - 1];
      context.globalState.update(HISTORY_KEY, history);
      const uri = vscode.Uri.file(filePath);
      vscode.workspace.openTextDocument(uri).then(doc => {
        vscode.window.showTextDocument(doc);
      });
    }
  }));
}

export function deactivate() {}
