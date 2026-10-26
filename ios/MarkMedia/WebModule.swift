import SwiftUI
import WebKit
import UIKit

struct WebModule: View {
    @EnvironmentObject var session: Session
    let path: String
    var query: [URLQueryItem] = []
    @State private var failure: String?
    @State private var retry = UUID()
    var body: some View {
        VStack(spacing: 0) {
            if let failure {
                Text(failure).foregroundStyle(.red).padding()
                Button("Spróbuj ponownie") { self.failure = nil; retry = UUID() }.padding()
            }
            Browser(session: session, path: path, query: query, failure: $failure).id(retry)
        }
    }
}
struct Browser: UIViewRepresentable {
    let session: Session
    let path: String
    let query: [URLQueryItem]
    @Binding var failure: String?
    func makeCoordinator() -> Coordinator { Coordinator(session: session, failure: $failure) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = session.webStore
        let controller = WKUserContentController()
        let encoded = (try? JSONEncoder().encode(session.account?.token ?? "")).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
        let origin = serviceURL.absoluteString
        controller.addUserScript(WKUserScript(source: "if(location.origin === '\(origin)'){localStorage.setItem('admin_token',\(encoded));window.print=()=>window.webkit.messageHandlers.printPage.postMessage('print');}", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.add(context.coordinator, name: "printPage")
        configuration.userContentController = controller
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
        context.coordinator.webView = view
        var components = URLComponents(url: serviceURL.appendingPathComponent(path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        let url = components.url!
        if let token = session.account?.token, let cookie = HTTPCookie(properties: [.domain: serviceURL.host!, .path: "/", .name: "mm_session", .value: token, .secure: "TRUE"]) {
            configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { view.load(URLRequest(url: url)) }
        } else { view.load(URLRequest(url: url)) }
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) { }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.stopLoading()
        view.configuration.userContentController.removeScriptMessageHandler(forName: "printPage")
        view.navigationDelegate = nil; view.uiDelegate = nil
    }
    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
        let session: Session
        @Binding var failure: String?
        weak var webView: WKWebView?
        var downloadFiles: [ObjectIdentifier: URL] = [:]
        init(session: Session, failure: Binding<String?>) { self.session = session; _failure = failure }
        private func presenter() -> UIViewController? {
            var current = webView?.window?.rootViewController
            while let presented = current?.presentedViewController { current = presented }
            return current
        }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { decisionHandler(.cancel); return }
            if url.scheme == "https", url.host == serviceURL.host, url.port == serviceURL.port {
                if url.path == "/login" || url.path == "/login.html" {
                    decisionHandler(.cancel); Task { await session.clear() }; return
                }
                if action.shouldPerformDownload { decisionHandler(.download); return }
                decisionHandler(.allow); return
            }
            if url.absoluteString.hasPrefix("blob:" + serviceURL.absoluteString + "/") { decisionHandler(action.shouldPerformDownload ? .download : .allow); return }
            decisionHandler(.cancel)
            if ["https", "mailto", "tel"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
        }
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if action.targetFrame == nil { webView.load(action.request) }
            return nil
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code != NSURLErrorCancelled { failure = "Brak połączenia. Sprawdź Internet i spróbuj ponownie." }
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code != NSURLErrorCancelled { failure = "Nie udało się otworzyć modułu." }
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "printPage", message.frameInfo.isMainFrame,
                  message.frameInfo.securityOrigin.host == serviceURL.host,
                  message.frameInfo.securityOrigin.protocol == "https", let webView else { return }
            let printer = UIPrintInteractionController.shared
            printer.printFormatter = webView.viewPrintFormatter()
            printer.present(from: CGRect(x: webView.bounds.midX, y: webView.bounds.maxY, width: 1, height: 1), in: webView, animated: true, completionHandler: nil)
        }
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            guard let presenter = presenter() else { completionHandler(); return }
            let alert = UIAlertController(title: "Mark Media", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            presenter.present(alert, animated: true)
        }
        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            guard let presenter = presenter() else { completionHandler(false); return }
            let alert = UIAlertController(title: "Mark Media", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Anuluj", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "Potwierdź", style: .default) { _ in completionHandler(true) })
            presenter.present(alert, animated: true)
        }
        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
            guard let presenter = presenter() else { completionHandler(nil); return }
            let alert = UIAlertController(title: "Mark Media", message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "Anuluj", style: .cancel) { _ in completionHandler(nil) })
            alert.addAction(UIAlertAction(title: "Zapisz", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
            presenter.present(alert, animated: true)
        }
        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            decisionHandler(response.canShowMIMEType ? .allow : .download)
        }
        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                let filename = URL(fileURLWithPath: suggestedFilename).lastPathComponent
                let file = folder.appendingPathComponent(filename.isEmpty ? "plik" : filename)
                downloadFiles[ObjectIdentifier(download)] = file
                completionHandler(file)
            } catch { completionHandler(nil) }
        }
        func downloadDidFinish(_ download: WKDownload) {
            guard let file = downloadFiles.removeValue(forKey: ObjectIdentifier(download)) else { return }
            guard let presenter = presenter() else { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()); return }
            let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
            share.popoverPresentationController?.sourceView = webView
            share.popoverPresentationController?.sourceRect = webView?.bounds ?? .zero
            share.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
            presenter.present(share, animated: true)
        }
        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            if let file = downloadFiles.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
            failure = "Nie udało się pobrać pliku. Spróbuj ponownie."
        }
    }
}
