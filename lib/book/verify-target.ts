/**
 * Where book verification runs.
 *
 * When a Windows runner is configured (WINDOWS_RUNNER_HOST), the Windows PC is
 * the verification machine for EVERY language and tool: tool discovery, check
 * commands, sample compiles and project builds all run there. Only tools that
 * exist solely on macOS (Swift, Xcode, AppleScript...) run on the Mac.
 *
 * Set BOOK_VERIFY_ON=local to go back to the Docker sandbox / this computer.
 */
import { runnerConfig } from './windows-runner';

const MAC_ONLY_TOOLS = new Set([
  'swift', 'swiftc', 'xcodebuild', 'xcrun', 'xcode-select', 'osascript', 'plutil', 'codesign', 'lipo',
  'ibtool', 'actool', 'pod', 'carthage', 'instruments', 'simctl', 'defaults', 'launchctl', 'sw_vers',
]);

export function isMacOnlyTool(program: string): boolean {
  const base = program.split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  return MAC_ONLY_TOOLS.has(base);
}

/** True when checks and builds should run on the Windows PC. */
export function windowsFirst(): boolean {
  return !!runnerConfig() && (process.env.BOOK_VERIFY_ON ?? 'windows').trim().toLowerCase() !== 'local';
}
