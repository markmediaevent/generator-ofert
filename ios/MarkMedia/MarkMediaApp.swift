import SwiftUI
import Security
import WebKit

let serviceURL = URL(string: "https://generator-ofert.onrender.com")!

struct Account: Codable {
    let token: String
    let username: String
    let role: String
}
struct ServerMessage: Decodable { let message: String? }
struct Me: Decodable { let username: String; let role: String }
struct Offer: Decodable, Identifiable {
    var id: String { offerNumber }
    let offerNumber: String
    let eventName: String
    let location: String
    let eventDate: String
    let assignedToMe: Bool
}
struct Offers: Decodable { let offers: [Offer] }
struct DayValue: Decodable { let status: String }
struct Availability: Decodable { let days: [String: DayValue] }
struct APIError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

enum CredentialStore {
    static let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "pl.markmedia.generatorofert", kSecAttrAccount as String: "session"]
    static func read() -> Account? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(Account.self, from: data)
    }
    static func save(_ account: Account) throws {
        let data = try JSONEncoder().encode(account)
        let update = [kSecValueData as String: data]
        let result = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if result == errSecItemNotFound {
            var request = query
            request[kSecValueData as String] = data
            request[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard SecItemAdd(request as CFDictionary, nil) == errSecSuccess else {
                throw APIError(message: "Nie można bezpiecznie zapisać sesji na urządzeniu.")
            }
        } else if result != errSecSuccess {
            throw APIError(message: "Nie można zapisać sesji.")
        }
    }
    static func clear() { SecItemDelete(query as CFDictionary) }
}

@MainActor final class Session: ObservableObject {
    @Published var account = CredentialStore.read()
    @Published var error: String?
    @Published var busy = false
    let webStore = WKWebsiteDataStore.nonPersistent()

    func call<T: Decodable>(_ path: String, method: String = "GET", body: [String: String]? = nil) async throws -> T {
        guard let url = URL(string: path, relativeTo: serviceURL)?.absoluteURL,
              url.host == serviceURL.host, url.scheme == "https" else { throw APIError(message: "Niepoprawny adres aplikacji.") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let token = account?.token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw APIError(message: "Brak odpowiedzi serwera.") }
        if response.statusCode == 401, account != nil {
            await clear()
            throw APIError(message: "Sesja wygasła. Zaloguj się ponownie.")
        }
        guard (200..<300).contains(response.statusCode) else {
            throw APIError(message: (try? JSONDecoder().decode(ServerMessage.self, from: data))?.message ?? "Serwer jest chwilowo niedostępny.")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    func login(username: String, password: String) async {
        busy = true; error = nil
        defer { busy = false }
        do {
            let response: Account = try await call("/api/login", method: "POST", body: ["username": username, "password": password])
            try CredentialStore.save(response)
            account = response
        } catch { self.error = error.localizedDescription }
    }
    func validate() async {
        guard account != nil else { return }
        do { let _: Me = try await call("/api/me") }
        catch { self.error = error.localizedDescription }
    }
    func clear() async {
        CredentialStore.clear()
        await webStore.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        account = nil
    }
    func logout() async {
        let _: ServerMessage? = try? await call("/api/logout", method: "POST")
        await clear()
    }
}

@main struct MarkMediaApp: App {
    @StateObject private var session = Session()
    var body: some Scene {
        WindowGroup {
            Group {
                if session.account != nil { MainTabs() } else { LoginScreen() }
            }
            .environmentObject(session)
            .tint(.blue)
            .task { await session.validate() }
        }
    }
}
struct LoginScreen: View {
    @EnvironmentObject var session: Session
    @State private var username = ""
    @State private var password = ""
    var body: some View {
        NavigationStack {
            Form {
                Section { Text("MARK MEDIA").font(.largeTitle.bold()); Text("Wydarzenia, packlisty i dyspozycyjność zespołu.") }
                Section("Logowanie") {
                    TextField("Login", text: $username).textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Hasło", text: $password).textContentType(.password)
                    Button(session.busy ? "Logowanie…" : "Zaloguj się") {
                        Task { await session.login(username: username, password: password); password = "" }
                    }.disabled(session.busy || username.isEmpty || password.isEmpty)
                }
                if let error = session.error { Section { Text(error).foregroundStyle(.red) } }
                Section { Link("Polityka prywatności", destination: serviceURL.appendingPathComponent("polityka-prywatnosci")) }
            }
        }
    }
}
struct MainTabs: View {
    @EnvironmentObject var session: Session
    var body: some View {
        TabView {
            NavigationStack { EventsScreen() }.tabItem { Label("Wydarzenia", systemImage: "list.bullet.rectangle") }
            NavigationStack { CalendarScreen() }.tabItem { Label("Dyspozycyjność", systemImage: "calendar") }
            NavigationStack {
                WebModule(path: session.account?.role == "admin" ? "/admin" : session.account?.role == "pracownik" ? "/packlists" : "/app")
                    .navigationTitle("Panel Mark Media").navigationBarTitleDisplayMode(.inline)
            }.tabItem { Label("Panel", systemImage: "square.grid.2x2") }
            NavigationStack {
                List {
                    Section("Konto") { Text(session.account?.username ?? ""); Text(session.account?.role ?? "") }
                    if session.account?.role == "admin" { NavigationLink("Dyspozycyjność zespołu") { WebModule(path: "/availability") } }
                    Link("Polityka prywatności", destination: serviceURL.appendingPathComponent("polityka-prywatnosci"))
                    Button("Wyloguj się", role: .destructive) { Task { await session.logout() } }
                }.navigationTitle("Konto")
            }.tabItem { Label("Konto", systemImage: "person.crop.circle") }
        }
    }
}
struct EventsScreen: View {
    @EnvironmentObject var session: Session
    @State private var offers: [Offer] = []
    @State private var error: String?
    @State private var search = ""
    @State private var loading = false
    var body: some View {
        List {
            if loading { ProgressView("Wczytywanie…") }
            if let error { Text(error).foregroundStyle(.red); Button("Spróbuj ponownie") { Task { await load() } } }
            if offers.isEmpty && !loading && error == nil { Text("Brak wydarzeń. Pracownik widzi tylko przypisane packlisty.") }
            ForEach(offers.filter { search.isEmpty || ($0.eventName + $0.location + $0.offerNumber).localizedCaseInsensitiveContains(search) }) { offer in
                NavigationLink {
                    WebModule(path: "/packlist", query: [URLQueryItem(name: "offer", value: offer.offerNumber)])
                        .navigationTitle(offer.eventName).navigationBarTitleDisplayMode(.inline)
                } label: {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(offer.eventName.isEmpty ? "Wydarzenie" : offer.eventName).font(.headline)
                        Text(offer.offerNumber).font(.caption)
                        Label(offer.eventDate.isEmpty ? "Data do ustalenia" : offer.eventDate, systemImage: "calendar")
                        Text(offer.location).font(.subheadline)
                        if offer.assignedToMe { Label("Przydzielono do Ciebie", systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
                    }.padding(.vertical, 6)
                }
            }
        }.navigationTitle("Wydarzenia").searchable(text: $search, prompt: "Szukaj wydarzenia")
            .refreshable { await load() }.task { await load() }
    }
    func load() async {
        loading = true; error = nil
        defer { loading = false }
        do { let response: Offers = try await session.call("/api/packlist-offers"); offers = response.offers }
        catch { offers = []; self.error = error.localizedDescription }
    }
}
