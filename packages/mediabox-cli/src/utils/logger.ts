import chalk from "chalk";
import ora, { type Ora } from "ora";

export function info(msg: string): void {
  console.log(chalk.blue("ℹ"), msg);
}

export function success(msg: string): void {
  console.log(chalk.green("✔"), msg);
}

export function warn(msg: string): void {
  console.log(chalk.yellow("⚠"), msg);
}

export function error(msg: string): void {
  console.log(chalk.red("✖"), msg);
}

export function header(msg: string): void {
  console.log();
  console.log(chalk.bold.cyan(msg));
  console.log(chalk.dim("─".repeat(60)));
}

export function spinner(text: string): Ora {
  return ora({ text, color: "cyan" }).start();
}

export function table(rows: [string, string, string][]): void {
  const colWidths = [20, 30, 10];
  const sep = "+" + colWidths.map((w) => "─".repeat(w + 2)).join("+") + "+";

  console.log(sep);
  for (const row of rows) {
    const cells = row.map((cell, i) => {
      const padded = cell.padEnd(colWidths[i]);
      // Color the status column
      if (i === 2) {
        if (cell.trim() === "Ready") return chalk.green(padded);
        if (cell.trim() === "Failed") return chalk.red(padded);
        return chalk.yellow(padded);
      }
      return padded;
    });
    console.log("| " + cells.join(" | ") + " |");
  }
  console.log(sep);
}
