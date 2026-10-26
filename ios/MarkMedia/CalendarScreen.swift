import SwiftUI

struct CalendarScreen: View {
    @EnvironmentObject var session: Session
    @State private var month = Date()
    @State private var days: [String: DayValue] = [:]
    @State private var selected: String?
    @State private var choosing = false
    @State private var busy = false
    @State private var error: String?
    private var calendar: Calendar {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = TimeZone(identifier: "Europe/Warsaw")!
        return value
    }
    private var monthKey: String {
        let parts = calendar.dateComponents([.year, .month], from: month)
        return String(format: "%04d-%02d", parts.year!, parts.month!)
    }
    private var count: Int { calendar.range(of: .day, in: .month, for: month)!.count }
    private var offset: Int {
        let first = calendar.date(from: calendar.dateComponents([.year, .month], from: month))!
        return (calendar.component(.weekday, from: first) + 5) % 7
    }
    private func label(_ state: String) -> String {
        switch state { case "available": return "Dostępny"; case "unavailable": return "Niedostępny"; default: return "Brak deklaracji" }
    }
    private func color(_ state: String) -> Color {
        switch state { case "available": return .green; case "unavailable": return .red; default: return .secondary }
    }
    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                HStack {
                    Button { shift(-1) } label: { Image(systemName: "chevron.left").padding() }.accessibilityLabel("Poprzedni miesiąc")
                    Spacer()
                    Text(month.formatted(.dateTime.month(.wide).year().locale(Locale(identifier: "pl_PL")))).font(.headline)
                    Spacer()
                    Button { shift(1) } label: { Image(systemName: "chevron.right").padding() }.accessibilityLabel("Następny miesiąc")
                }.disabled(busy)
                Text("Wybierz dzień i zaznacz, czy możesz pracować. Deklaracje widzi administrator.").font(.subheadline).foregroundStyle(.secondary)
                if busy { ProgressView() }
                if let error { Text(error).foregroundStyle(.red); Button("Odśwież") { Task { await load() } } }
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 7), spacing: 8) {
                    ForEach(["Pon", "Wt", "Śr", "Czw", "Pt", "Sob", "Niedz"], id: \.self) { Text($0).font(.caption) }
                    ForEach(0..<offset, id: \.self) { _ in Color.clear.frame(height: 1) }
                    ForEach(1...count, id: \.self) { day in
                        let date = monthKey + String(format: "-%02d", day)
                        let state = days[date]?.status ?? "unknown"
                        Button { selected = date; choosing = true } label: {
                            VStack(spacing: 8) {
                                Text("\(day)").font(.headline)
                                Image(systemName: state == "available" ? "checkmark" : state == "unavailable" ? "xmark" : "minus")
                            }.frame(maxWidth: .infinity, minHeight: 66).background(color(state).opacity(0.18), in: RoundedRectangle(cornerRadius: 10))
                        }.buttonStyle(.plain).foregroundStyle(color(state)).disabled(busy)
                            .accessibilityLabel("\(date), \(label(state))")
                    }
                }
                VStack(alignment: .leading, spacing: 10) {
                    Label("Dostępny", systemImage: "checkmark").foregroundStyle(.green)
                    Label("Niedostępny", systemImage: "xmark").foregroundStyle(.red)
                    Label("Brak deklaracji", systemImage: "minus").foregroundStyle(.secondary)
                }.font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
            }.padding()
        }.navigationTitle("Dyspozycyjność").task(id: monthKey) { await load() }.refreshable { await load() }
            .confirmationDialog(selected ?? "Dyspozycyjność", isPresented: $choosing, titleVisibility: .visible) {
                Button("Dostępny") { save("available") }
                Button("Niedostępny", role: .destructive) { save("unavailable") }
                Button("Usuń deklarację") { save("unknown") }
                Button("Anuluj", role: .cancel) { }
            }
    }
    private func shift(_ delta: Int) {
        guard let next = calendar.date(byAdding: .month, value: delta, to: month),
              (2000...2100).contains(calendar.component(.year, from: next)) else { return }
        month = next
    }
    private func load() async {
        let requested = monthKey
        busy = true; error = nil; days = [:]
        defer { busy = false }
        do {
            let response: Availability = try await session.call("/api/my-availability?month=" + requested)
            if requested == monthKey { days = response.days }
        } catch { self.error = error.localizedDescription }
    }
    private func save(_ state: String) {
        guard let selected, !busy else { return }
        busy = true; error = nil
        Task {
            defer { busy = false }
            do {
                let response: Availability = try await session.call("/api/my-availability", method: "PATCH", body: ["date": selected, "status": state])
                if selected.hasPrefix(monthKey) { days = response.days }
            } catch { self.error = error.localizedDescription }
        }
    }
}
