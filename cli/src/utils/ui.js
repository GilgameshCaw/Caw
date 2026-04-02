import chalk from 'chalk'

export const brand = chalk.hex('#FFD700') // CAW gold
export const dim = chalk.dim
export const success = chalk.green
export const warn = chalk.yellow
export const err = chalk.red
export const info = chalk.cyan
export const bold = chalk.bold

export function banner() {
  console.log()
  console.log(brand.bold('  ██████╗ █████╗ ██╗    ██╗'))
  console.log(brand.bold('  ██╔═══╝██╔══██╗██║    ██║'))
  console.log(brand.bold('  ██║    ███████║██║ █╗ ██║'))
  console.log(brand.bold('  ██║    ██╔══██║██║███╗██║'))
  console.log(brand.bold('  ██████╗██║  ██║╚███╔███╔╝'))
  console.log(brand.bold('  ╚═════╝╚═╝  ╚═╝ ╚══╝╚══╝'))
  console.log()
  console.log(dim('  A trustless, decentralized social clearing-house'))
  console.log(dim('  focused on freedom of speech.'))
  console.log()
}

export function section(title) {
  console.log()
  console.log(brand('─'.repeat(50)))
  console.log(brand.bold(`  ${title}`))
  console.log(brand('─'.repeat(50)))
  console.log()
}

export function tip(text) {
  console.log(dim(`  💡 ${text}`))
}

export function tipBlock(lines) {
  console.log()
  console.log(dim('  ┌─────────────────────────────────────────────'))
  for (const line of lines) {
    console.log(dim(`  │ ${line}`))
  }
  console.log(dim('  └─────────────────────────────────────────────'))
  console.log()
}
