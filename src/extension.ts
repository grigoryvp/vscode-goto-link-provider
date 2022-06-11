import { promisify } from "util";
import { exec } from "child_process";
import * as path from "path";
import * as vscode from "vscode";


const PREFIX = "goto://";

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
  const filepath = path.join(...prefixes);
  const anchors = suffixes;
  if (suffixes) {
    return new vscode.DocumentLink(range,
      vscode.Uri.parse(`command:extension.goto-link-provider.open?${
        encodeURIComponent(JSON.stringify({filepath, anchors}))
      }`)
    );
  }
  else {
    //  If no anchor like [foo#bar] or foo#bar[] is specified, use
    //  normal file //  uri so VSCode will ask to create a file if
    //  it does not exists.
    return new vscode.DocumentLink(range, vscode.Uri.file(filepath));
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

  const openCmdName = "extension.goto-link-provider.open";
  dispose(vscode.commands.registerCommand(openCmdName, (argmap) => {
    if (!argmap) return;
    const {filepath, anchors} = argmap;
    const uri = vscode.Uri.file(filepath);
    vscode.workspace.openTextDocument(uri).then(doc => {
      vscode.window.showTextDocument(doc).then(() => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
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
}

export function deactivate() {}
