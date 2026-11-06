# Mission Control: install guide (for Claude Code)

You are Claude Code, setting up Mission Control on this computer for its owner.
Mission Control is a local web dashboard (http://localhost:4100) that shows every
Claude Code session on this computer as a tile, lets the owner chat with each one,
flags sessions waiting for input, and shows a "Thinking" timer.
It runs only on this computer and only reads ~/.claude. Nothing is sent anywhere.

First check the operating system, then follow the matching section.

## Mac

1. Check Node.js 20+ (`node -v`). If missing or older, install it (`brew install node`, or the LTS from nodejs.org).
2. Check Xcode Command Line Tools (`xcode-select -p`). If missing, run `xcode-select --install`,
   ask the owner to click Install in the popup, wait for it to finish, then continue.
3. Optional voice input: ask the owner for a Groq API key (free at console.groq.com). Otherwise skip.
4. From this folder run `bash scripts/install.sh` (or `GROQ_API_KEY=gsk_... bash scripts/install.sh`).
5. Open http://localhost:4100 and confirm it loads. If not, read ~/Library/Logs/mission-control/stderr.log and fix the cause.
6. Tell the owner to restart open Claude Code windows, and that "Mission Control" is now in ~/Applications.
Remove later with `bash scripts/uninstall.sh`.

## Windows (Claude Code running normally in PowerShell or Command Prompt, not WSL)

1. Check Node.js 20+ (`node -v`). If missing or older, ask the owner to install the LTS from nodejs.org
   (or `winget install OpenJS.NodeJS.LTS`), then open a new terminal and continue.
2. Optional voice input: ask for a Groq API key (free at console.groq.com) and set it first:
   `$env:GROQ_API_KEY="gsk_..."`. Otherwise skip.
3. From this folder run in PowerShell: `powershell -ExecutionPolicy Bypass -File scripts\install.ps1`
4. If `npm install` fails on node-pty or node-gyp: install "Visual Studio Build Tools" with the
   "Desktop development with C++" workload (`winget install Microsoft.VisualStudio.2022.BuildTools`,
   then add that workload in the Visual Studio Installer), then run step 3 again.
5. Open http://localhost:4100 and confirm it loads. If not, read %LOCALAPPDATA%\mission-control.log and fix the cause.
   This Windows version is new: if a feature misbehaves (starting a new console, the waiting alert),
   read the log, fix the code in this folder, and tell the owner what you changed.
6. Tell the owner to restart open Claude Code windows, and that "Mission Control" is now a shortcut on the Desktop.
   It starts automatically, hidden, every time they log in.
Remove later with `powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1`.

## Notes
- Don't change files outside this folder and ~/.claude except what the installer does.
- Port 4100 must be free. If something else uses it, ask the owner before stopping it.
