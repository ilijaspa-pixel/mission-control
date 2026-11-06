// Cross-platform start (Windows can't use the `VAR=1 cmd` syntax in package.json).
import { spawn } from "node:child_process";
const env = { ...process.env, WS_NO_BUFFER_UTIL: "1", WS_NO_UTF_8_VALIDATE: "1" };
const bin = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(bin, ["next", "dev", "-p", "4100"], { stdio: "inherit", env, shell: process.platform === "win32" });
child.on("exit", (code) => process.exit(code ?? 0));
