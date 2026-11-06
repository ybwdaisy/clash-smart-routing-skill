import AppKit
import Foundation

// A short-lived native process launched by user launchd checks the same system
// proxy path as native GUI networking, without curl's environment-only behavior.
if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--probe" {
    let output = CommandLine.arguments[2]
    let keys = ["http_proxy", "https_proxy", "all_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]
    let environment = ProcessInfo.processInfo.environment.filter { keys.contains($0.key) }
    let start = Date()
    let semaphore = DispatchSemaphore(value: 0)
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 20
    config.timeoutIntervalForResource = 25
    let session = URLSession(configuration: config)
    var request = URLRequest(url: URL(string: "https://chatgpt.com/robots.txt")!)
    request.httpMethod = "HEAD"
    session.dataTask(with: request) { _, response, error in
        var result: [String: Any] = ["environment": environment,
            "httpStatus": (response as? HTTPURLResponse)?.statusCode ?? 0,
            "elapsedMs": Int(Date().timeIntervalSince(start) * 1000)]
        if let error = error { result["error"] = error.localizedDescription }
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: output), options: .atomic)
        }
        semaphore.signal()
    }.resume()
    _ = semaphore.wait(timeout: .now() + 28)
    exit(0)
}

func send(_ event: String) {
    if let data = try? JSONSerialization.data(withJSONObject: ["event": event]),
       let text = String(data: data, encoding: .utf8) {
        print(text)
        fflush(stdout)
    }
}
let center = NSWorkspace.shared.notificationCenter
let names = ["FlClash.app", "Clash Verge.app", "Clash Verge Rev.app", "Clash.app"]
for (notification, event) in [(NSWorkspace.didLaunchApplicationNotification, "launch"), (NSWorkspace.didTerminateApplicationNotification, "terminate")] {
    center.addObserver(forName: notification, object: nil, queue: .main) { info in
        if let app = info.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
           let name = app.bundleURL?.lastPathComponent, names.contains(name) { send(event) }
    }
}
send("ready")
RunLoop.main.run()
