// Adds Mission Control's status line and "needs you" hook to ~/.claude/settings.json.
// Backs the file up first and never replaces an existing status line. Mac and Windows.
const fs = require("fs"), os = require("os"), path = require("path");
const dir = path.join(os.homedir(), ".claude");
const p = path.join(dir, "settings.json");
let s = {};
if (fs.existsSync(p)) { s = JSON.parse(fs.readFileSync(p, "utf8")); fs.copyFileSync(p, p + ".before-mission-control"); }
const win = process.platform === "win32";
const statusCmd = win ? `node "${path.join(dir, "statusline.cjs")}" --width 50` : `${path.join(dir, "statusline.cjs")} --width 50`;
const hookCmd = win
  ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(dir, "hooks", "notify-waiting.ps1")}"`
  : path.join(dir, "hooks", "notify-waiting.sh");
if (!s.statusLine) s.statusLine = { type: "command", command: statusCmd };
else console.log("You already have a status line; left it as is.");
s.hooks = s.hooks || {};
const list = (s.hooks.Notification = s.hooks.Notification || []);
if (!JSON.stringify(list).includes("notify-waiting")) list.push({ hooks: [{ type: "command", command: hookCmd, timeout: 10, async: true }] });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(p, JSON.stringify(s, null, 2));
console.log("Updated " + p + " (backup: settings.json.before-mission-control)");
