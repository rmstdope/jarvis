// J.A.R.V.I.S. macOS launcher: a WKWebView over the local service. Built by bundle.sh with swiftc (no Xcode project).
import Cocoa
import WebKit
import Network

let PORT = 7281
let BASE = "http://localhost:\(PORT)"

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var backend: Process?
    var urlLabel: NSTextField!
    let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/jarvis/jarvis.log")

    func applicationDidFinishLaunching(_ n: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMenus()
        buildWindow()
        probeBackend { running in
            if running { self.waitAndLoad() } else { self.startManagedBackend() }
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ n: Notification) {
        guard let p = backend, p.isRunning else { return }
        p.terminate()
        let deadline = Date().addingTimeInterval(5)
        while p.isRunning && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
    }

    // MARK: UI
    func buildMenus() {
        let main = NSMenu()
        let app = NSMenuItem(); main.addItem(app)
        let appMenu = NSMenu(); app.submenu = appMenu
        appMenu.addItem(withTitle: "About J.A.R.V.I.S.", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit J.A.R.V.I.S.", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let edit = NSMenuItem(); main.addItem(edit)
        let editMenu = NSMenu(title: "Edit"); edit.submenu = editMenu
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let view = NSMenuItem(); main.addItem(view)
        let viewMenu = NSMenu(title: "View"); view.submenu = viewMenu
        viewMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        NSApp.mainMenu = main
    }
    func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "J.A.R.V.I.S."
        window.appearance = NSAppearance(named: .darkAqua)
        window.center()
        let cfg = WKWebViewConfiguration()
        let marker = WKUserScript(source: "window.__JARVIS_APP__ = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true)
        cfg.userContentController.addUserScript(marker)
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        let toolbar = NSToolbar(identifier: "main")
        toolbar.delegate = self
        toolbar.displayMode = .iconAndLabel
        window.toolbar = toolbar
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    @objc func reload() { web.reload() }
    @objc func goHome() { web.load(URLRequest(url: URL(string: BASE)!)) }
    @objc func goBack() { web.goBack() }
    @objc func goForward() { web.goForward() }
    @objc func openInBrowser() { NSWorkspace.shared.open(URL(string: BASE)!) }

    // MARK: backend
    func probeBackend(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: URL(string: "\(BASE)/api/health")!)
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            DispatchQueue.main.async { done((resp as? HTTPURLResponse) != nil) }
        }.resume()
    }
    func waitAndLoad(attempt: Int = 0) {
        probeBackend { ok in
            if ok { self.web.load(URLRequest(url: URL(string: BASE)!)) }
            else if attempt < 120 { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.waitAndLoad(attempt: attempt + 1) } }
            else { self.fatal("The J.A.R.V.I.S. service did not become ready on port \(PORT) within 120 s. See \(self.logURL.path)") }
        }
    }
    func repoPath() -> String? {
        guard let p = Bundle.main.url(forResource: "repo-path", withExtension: nil), let s = try? String(contentsOf: p, encoding: .utf8) else { return nil }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    func findBun() -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        for c in ["/opt/homebrew/bin/bun", "/usr/local/bin/bun", "\(home)/.bun/bin/bun"] where FileManager.default.isExecutableFile(atPath: c) { return c }
        for dir in (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":") {
            let c = "\(dir)/bun"
            if FileManager.default.isExecutableFile(atPath: c) { return c }
        }
        return nil
    }
    func startManagedBackend() {
        guard let repo = repoPath() else { return fatal("repo-path resource missing; rebuild with bundle.sh") }
        for f in ["src/server.ts", "src/cli.ts", "package.json", "bun.lock", "web/index.html"] where !FileManager.default.fileExists(atPath: "\(repo)/\(f)") {
            return fatal("\(repo) does not look like the jarvis code repo (missing \(f))")
        }
        guard let bun = findBun() else { return fatal("bun not found (install from https://bun.sh)") }
        try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
        let log = try? FileHandle(forWritingTo: logURL)
        log?.seekToEndOfFile()
        DispatchQueue.global().async {
            for step in [[bun, "install", "--frozen-lockfile"], [bun, "run", "web:build"]] {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: step[0]); p.arguments = Array(step.dropFirst()); p.currentDirectoryURL = URL(fileURLWithPath: repo)
                p.standardOutput = log; p.standardError = log
                do { try p.run() } catch { return DispatchQueue.main.async { self.fatal("could not run \(step.joined(separator: " ")): \(error)") } }
                p.waitUntilExit()
                if p.terminationStatus != 0 { return DispatchQueue.main.async { self.fatal("\(step.joined(separator: " ")) exited with \(p.terminationStatus). See \(self.logURL.path)") } }
            }
            let serve = Process()
            serve.executableURL = URL(fileURLWithPath: bun); serve.arguments = ["run", "src/cli.ts", "serve", "--port", String(PORT)]; serve.currentDirectoryURL = URL(fileURLWithPath: repo)
            serve.standardOutput = log; serve.standardError = log
            do { try serve.run() } catch { return DispatchQueue.main.async { self.fatal("could not start the service: \(error)") } }
            DispatchQueue.main.async { self.backend = serve; self.waitAndLoad() }
        }
    }
    func fatal(_ msg: String) {
        let a = NSAlert(); a.messageText = "J.A.R.V.I.S. could not start"; a.informativeText = msg; a.alertStyle = .critical; a.runModal(); NSApp.terminate(nil)
    }

    // MARK: web view
    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = action.request.url, let host = u.host, !["localhost", "127.0.0.1"].contains(host), u.scheme?.hasPrefix("http") == true {
            NSWorkspace.shared.open(u); return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.waitAndLoad() }
    }
    func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel(); panel.allowsMultipleSelection = p.allowsMultipleSelection; panel.canChooseDirectories = p.allowsDirectories
        panel.begin { completionHandler($0 == .OK ? panel.urls : nil) }
    }
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url { if u.host == "localhost" || u.host == "127.0.0.1" { web.load(a.request) } else { NSWorkspace.shared.open(u) } }
        return nil
    }
}

extension AppDelegate: NSToolbarDelegate {
    func toolbarAllowedItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { toolbarDefaultItemIdentifiers(t) }
    func toolbarDefaultItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { [NSToolbarItem.Identifier("home"), NSToolbarItem.Identifier("back"), NSToolbarItem.Identifier("forward"), NSToolbarItem.Identifier("url"), .flexibleSpace, NSToolbarItem.Identifier("reload")] }
    func toolbar(_ t: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar: Bool) -> NSToolbarItem? {
        let item = NSToolbarItem(itemIdentifier: id)
        switch id.rawValue {
        case "home": item.label = "Home"; item.image = NSImage(systemSymbolName: "house", accessibilityDescription: nil); item.action = #selector(goHome)
        case "back": item.label = "Back"; item.image = NSImage(systemSymbolName: "chevron.left", accessibilityDescription: nil); item.action = #selector(goBack)
        case "forward": item.label = "Forward"; item.image = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil); item.action = #selector(goForward)
        case "reload": item.label = "Reload"; item.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: nil); item.action = #selector(reload)
        case "url":
            let b = NSButton(title: BASE, target: self, action: #selector(openInBrowser)); b.bezelStyle = .inline; b.isBordered = false
            item.view = b; item.label = "Open in browser"
        default: return nil
        }
        item.target = self
        return item
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
