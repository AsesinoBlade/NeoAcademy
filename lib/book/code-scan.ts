/**
 * Static scan of code before it is RUN (compiling is unaffected).
 *
 * A sample that reaches the network, starts processes, touches the registry,
 * or deletes files is never executed — even in the sandbox — only compiled /
 * syntax-checked. Language-agnostic patterns; false positives just mean a
 * sample is compiled instead of run.
 */
const RULES: Array<[string, RegExp]> = [
  // Language-independent: code that will be RUN must not contain a URL at all.
  ['a web address (network access)', /\b(https?|ftp|wss?):\/\/[^\s'"`)]+/i],
  ['network libraries', /\b(fphttpclient|TFPHTTPClient|SimpleGet|httpsend|THTTPSend|synapse|IdHTTP|TIdTCPClient|ssockets|TInetSocket|WinSock|winsock2|ws2_32|libcurl|boost::asio|QNetworkAccessManager|urllib3|aiohttp|httpx|axios|got\(|node-fetch|net\.Socket|dgram|java\.net|HttpURLConnection|okhttp)\b/i],
  ['network access', /\b(socket|connect\s*\(|urlopen|urllib|requests\.(get|post)|http\.client|fetch\s*\(|XMLHttpRequest|WebSocket|HttpClient|WebClient|WinHttp|InternetOpen|URLDownloadToFile|curl_easy|wininet|TIdHTTP|TNetHTTPClient|net\.Dial|http\.Get|reqwest|System\.Net)\b/i],
  ['starting processes', /\b(system\s*\(|popen|exec[lv]p?e?\s*\(|subprocess|os\.system|child_process|spawn\s*\(|execSync|CreateProcess|ShellExecute|WinExec|Runtime\.getRuntime\(\)\.exec|ProcessBuilder|Process\.Start|ExecuteProcess|TProcess|os\/exec|std::process::Command)\b/i],
  ['the Windows registry', /\b(RegSetValue|RegCreateKey|RegDeleteKey|RegOpenKey|winreg|Microsoft\.Win32\.Registry|TRegistry|HKEY_)\w*/i],
  ['deleting files', /\b(rm\s+-rf|shutil\.rmtree|DeleteFile[AW]?|RemoveDirectory|unlink\s*\(|fs\.rm|rmSync|unlinkSync|Remove-Item|SHFileOperation|std::filesystem::remove_all|DeleteFile\()\b/i],
  ['loading native code', /\b(LoadLibrary[AW]?|dlopen|ctypes\.(cdll|windll|CDLL)|DllImport|System\.loadLibrary)\b/i],
  ['dynamic code execution', /\b(eval\s*\(|exec\s*\(|new\s+Function\s*\(|__import__\s*\(|compile\s*\(.*exec)/i],
];

export function scanForDangerousCode(code: string): string[] {
  const hits: string[] = [];
  for (const [label, re] of RULES) if (re.test(code)) hits.push(label);
  return hits;
}
